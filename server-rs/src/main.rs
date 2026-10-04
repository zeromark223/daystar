//! Daystar's game server in Rust: the standalone server of server/src/ (rooms,
//! roles, voice relay, snapshot groups, overcharge, area of interest) speaking
//! the same protocol, for comparing languages. No cluster mode.
//!
//!   cargo run --release              # one thread, like Bun's single JS thread
//!   RS_THREADS=0 cargo run --release # all cores
//!
//! Environment: PORT (3000), HOST (0.0.0.0), RS_THREADS (1; 0 = all cores),
//! ROOM_SECRET, HEALTH_TOKEN, EGRESS_BUDGET_MBPS, CLIENT_DIR (client/dist).

mod constants;
mod host_key;
mod http;
mod overcharge;
mod protocol;
mod registry;
mod room;
mod stats;
mod world;

use std::path::PathBuf;
use std::sync::Arc;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn main() {
    let threads: usize = env("RS_THREADS").and_then(|v| v.parse().ok()).unwrap_or(1);
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    let workers = if threads == 0 { cores } else { threads };
    let runtime = if workers == 1 {
        tokio::runtime::Builder::new_current_thread().enable_all().build()
    } else {
        tokio::runtime::Builder::new_multi_thread().worker_threads(workers).enable_all().build()
    }
    .expect("tokio runtime");
    let label = if workers == 1 { "rust tokio, 1 thread".to_string() } else { format!("rust tokio, {workers} threads") };
    runtime.block_on(serve(label, workers));
}

async fn serve(label: String, workers: usize) {
    let port = env("PORT").and_then(|v| v.parse().ok()).unwrap_or(3000u16);
    let host = env("HOST").unwrap_or_else(|| "0.0.0.0".into());
    let client_dir = env("CLIENT_DIR").map(PathBuf::from).unwrap_or_else(|| {
        ["client/dist", "../client/dist"].iter().map(PathBuf::from).find(|p| p.join("index.html").exists()).unwrap_or("client/dist".into())
    });
    let secret: Arc<str> = host_key::secret_from_env().into();
    let stats = Arc::new(stats::Stats::new(label.clone()));
    let registry = registry::Registry::new(stats.clone(), secret.clone());
    let egress_budget = env("EGRESS_BUDGET_MBPS").and_then(|v| v.parse().ok()).filter(|v: &f64| *v > 0.0);
    // The CPU budget is the cores the server may use.
    let overcharge = overcharge::Overcharge::new(egress_budget, workers as f64);
    let on_rate = registry.clone();
    stats::start(stats.clone(), overcharge, move |rate| on_rate.set_rate(rate));

    let state = http::AppState {
        registry,
        stats,
        secret,
        health_token: env("HEALTH_TOKEN").map(Into::into),
        client_dir: Arc::new(client_dir.clone()),
    };
    use axum::serve::ListenerExt;
    // Small frames go out at once (uWebSockets, behind Bun, does the same); Nagle
    // would hold them for tens of milliseconds.
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await.expect("bind").tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    println!("daystar (rust) on http://{host}:{port} ({label}, standalone, client from {})", client_dir.display());
    axum::serve(listener, http::router(state)).await.expect("server");
}
