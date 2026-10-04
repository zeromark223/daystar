//! Load samples once per second, served by GET /api/health in the same shape
//! as the TypeScript server (server/src/stats.ts), so tools/loadtest.ts reads both.

use crate::overcharge::Overcharge;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HISTORY: usize = 300;
const PROBE: Duration = Duration::from_millis(20);

pub struct Stats {
    pub runtime: String,
    started: Instant,
    pub players: AtomicI64,
    pub sockets: AtomicI64,
    pub rooms: AtomicI64,
    egress_bytes: AtomicU64,
    /// Snapshots per second per player (the overcharge's decision) and its load score x 100.
    pub rate: AtomicU32,
    load_x100: AtomicU32,
    ticks: Mutex<Vec<f64>>,
    lateness: Mutex<Vec<f64>>,
    samples: Mutex<VecDeque<Value>>,
}

pub fn epoch_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

impl Stats {
    pub fn new(runtime: String) -> Stats {
        Stats {
            runtime,
            started: Instant::now(),
            players: AtomicI64::new(0),
            sockets: AtomicI64::new(0),
            rooms: AtomicI64::new(0),
            egress_bytes: AtomicU64::new(0),
            rate: AtomicU32::new(crate::constants::TICK_RATE),
            load_x100: AtomicU32::new(0),
            ticks: Mutex::new(Vec::new()),
            lateness: Mutex::new(Vec::new()),
            samples: Mutex::new(VecDeque::new()),
        }
    }

    pub fn record_tick(&self, ms: f64) {
        self.ticks.lock().unwrap().push(ms);
    }

    pub fn record_egress(&self, bytes: usize) {
        self.egress_bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    /// Body of GET /api/health; `since` (epoch ms) limits the history returned.
    pub fn report(&self, since: f64) -> Value {
        let samples = self.samples.lock().unwrap();
        json!({
            "status": "ok",
            "runtime": self.runtime,
            "now": epoch_ms(),
            "uptimeSec": self.started.elapsed().as_secs(),
            "latest": samples.back(),
            "samples": samples.iter().filter(|s| s["t"].as_f64().unwrap_or(0.0) > since).collect::<Vec<_>>(),
        })
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() as f64 * p) as usize).min(sorted.len() - 1)]
}

fn round(v: f64, digits: i32) -> f64 {
    let f = 10f64.powi(digits);
    (v * f).round() / f
}

/// Process CPU time (all threads), in seconds; works on Linux, macOS and Windows.
fn cpu_seconds() -> f64 {
    cpu_time::ProcessTime::try_now().map_or(0.0, |t| t.as_duration().as_secs_f64())
}

fn rss_mb() -> f64 {
    memory_stats::memory_stats().map_or(0.0, |m| (m.physical_mem as f64 / 1e6).round())
}

/// Start the loop-delay probe and the once-a-second sampler; `on_rate` gets the
/// overcharge's new snapshot rate when it changes.
pub fn start(stats: std::sync::Arc<Stats>, mut overcharge: Overcharge, on_rate: impl Fn(u32) + Send + 'static) {
    let probe = stats.clone();
    tokio::spawn(async move {
        loop {
            let expected = tokio::time::Instant::now() + PROBE;
            tokio::time::sleep_until(expected).await;
            let late = tokio::time::Instant::now().saturating_duration_since(expected);
            probe.lateness.lock().unwrap().push(late.as_secs_f64() * 1000.0);
        }
    });
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.tick().await;
        let mut last_cpu = cpu_seconds();
        let mut last_at = Instant::now();
        loop {
            interval.tick().await;
            let elapsed = last_at.elapsed().as_secs_f64();
            let cpu_now = cpu_seconds();
            let cpu = (cpu_now - last_cpu) / elapsed;
            last_cpu = cpu_now;
            last_at = Instant::now();
            let mut late = std::mem::take(&mut *stats.lateness.lock().unwrap());
            late.sort_by(|a, b| a.total_cmp(b));
            let mut ticks = std::mem::take(&mut *stats.ticks.lock().unwrap());
            ticks.sort_by(|a, b| a.total_cmp(b));
            let egress_mbps = stats.egress_bytes.swap(0, Ordering::Relaxed) as f64 * 8.0 / 1e6 / elapsed;
            let loop_p99 = percentile(&late, 0.99);
            if let Some(rate) = overcharge.observe(loop_p99, cpu, egress_mbps) {
                stats.rate.store(rate, Ordering::Relaxed);
                println!("overcharge: {rate} snapshots/s per player (load {:.2})", overcharge.score);
                on_rate(rate);
            }
            stats.load_x100.store((overcharge.score * 100.0).round() as u32, Ordering::Relaxed);
            let sample = json!({
                "t": epoch_ms(),
                "rooms": stats.rooms.load(Ordering::Relaxed),
                "players": stats.players.load(Ordering::Relaxed),
                "sockets": stats.sockets.load(Ordering::Relaxed),
                "cpu": round(cpu, 3),
                "loopP99Ms": round(loop_p99, 1),
                "loopMaxMs": round(late.last().copied().unwrap_or(0.0), 1),
                "ticks": ticks.len(),
                "tickP99Ms": round(percentile(&ticks, 0.99), 2),
                "tickMaxMs": round(ticks.last().copied().unwrap_or(0.0), 2),
                "rssMb": rss_mb(),
                "heapMb": 0,
                "egressMbps": round(egress_mbps, 1),
                "snapshotHz": stats.rate.load(Ordering::Relaxed),
                "load": stats.load_x100.load(Ordering::Relaxed) as f64 / 100.0,
            });
            let mut samples = stats.samples.lock().unwrap();
            samples.push_back(sample);
            if samples.len() > HISTORY {
                samples.pop_front();
            }
        }
    });
}
