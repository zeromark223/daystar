//! HTTP routes and WebSocket connections (server/src/app.ts and main.ts, standalone).

use crate::constants::MAX_FRAME_BYTES;
use crate::registry::Registry;
use crate::room::{Event, Out};
use crate::stats::Stats;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::Frame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::{Data, OpCode};
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;

type Socket = WebSocketStream<hyper_util::rt::TokioIo<hyper::upgrade::Upgraded>>;

/// Frames waiting for one client; beyond this the client is not keeping up and
/// frames are dropped (Bun drops them past its backpressure limit too).
const OUTBOX: usize = 512;
/// Close sockets that stop answering pings for this long.
const IDLE: Duration = Duration::from_secs(60);
const PING_EVERY: Duration = Duration::from_secs(25);
/**
 * Bigger frames go out as fragments of this size. The WebSocket library keeps
 * its write buffer at the size of the largest frame it ever wrote, and "welcome"
 * lists the whole room (~25 B per player): unfragmented, every socket would keep
 * a buffer as big as its welcome (2 GB across 13,000 players).
 */
const FRAGMENT: usize = 8 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<Registry>,
    pub stats: Arc<Stats>,
    pub secret: Arc<str>,
    pub health_token: Option<Arc<str>>,
    pub client_dir: Arc<PathBuf>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/health", get(health))
        .route("/api/join", post(join))
        .route("/api/rooms", post(create_room))
        .route("/ws", get(ws))
        .fallback(get(static_file))
        .with_state(state)
}

fn valid_room(room: &str) -> bool {
    (1..=32).contains(&room.len()) && room.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

async fn health(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    if let Some(token) = &s.health_token {
        let given = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_string)
            .or_else(|| q.get("token").cloned())
            .unwrap_or_default();
        if given.as_bytes() != token.as_bytes() {
            return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
        }
    }
    let since = q.get("since").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    ([(header::CACHE_CONTROL, "no-store")], Json(s.stats.report(since))).into_response()
}

#[derive(Deserialize)]
struct JoinRequest {
    room: String,
}

/// Standalone: clients ask where to connect; the answer is this server.
async fn join(body: axum::body::Bytes) -> Response {
    if body.len() > 1024 {
        return (StatusCode::BAD_REQUEST, "Invalid room").into_response();
    }
    match serde_json::from_slice::<JoinRequest>(&body) {
        Ok(r) if valid_room(&r.room) => Json(json!({ "serverId": 0, "wsUrl": format!("/ws?room={}", r.room) })).into_response(),
        _ => (StatusCode::BAD_REQUEST, "Invalid room").into_response(),
    }
}

async fn create_room(State(s): State<AppState>) -> Response {
    let room = crate::host_key::new_room_id();
    let host_key = crate::host_key::host_key_for(&room, &s.secret);
    ([(header::CACHE_CONTROL, "no-store")], Json(json!({ "room": room, "hostKey": host_key }))).into_response()
}

/// WebSocket upgrade, done by hand so frames can be fragmented (see FRAGMENT).
async fn ws(State(s): State<AppState>, Query(q): Query<HashMap<String, String>>, req: Request) -> Response {
    let Some(room) = q.get("room").filter(|r| valid_room(r)).cloned() else {
        return (StatusCode::BAD_REQUEST, "Bad request").into_response();
    };
    let headers = req.headers();
    let upgrade = headers.get(header::UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let Some(key) = headers.get(header::SEC_WEBSOCKET_KEY).filter(|_| upgrade) else {
        return (StatusCode::UPGRADE_REQUIRED, "WebSocket upgrade required").into_response();
    };
    let accept = derive_accept_key(key.as_bytes());
    let events = s.registry.acquire(&room);
    let stats = s.stats.clone();
    let conn = next_conn();
    let on_upgrade = hyper::upgrade::on(req);
    tokio::spawn(async move {
        match on_upgrade.await {
            Ok(upgraded) => {
                let config = WebSocketConfig::default()
                    .read_buffer_size(8 * 1024)
                    .write_buffer_size(8 * 1024)
                    .max_write_buffer_size(4 * 1024 * 1024)
                    .max_message_size(Some(MAX_FRAME_BYTES))
                    .max_frame_size(Some(MAX_FRAME_BYTES));
                let io = hyper_util::rt::TokioIo::new(upgraded);
                let socket = WebSocketStream::from_raw_socket(io, Role::Server, Some(config)).await;
                connection(conn, socket, events, stats).await;
            }
            // The room counted this connection: let it know it is not coming.
            Err(_) => {
                let _ = events.send(Event::Close { conn });
            }
        }
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_ACCEPT, accept)
        .body(Body::empty())
        .unwrap()
}

fn next_conn() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// One client: a writer task drains its outbox (several frames per flush when
/// they pile up); this task reads frames and forwards them to the room.
async fn connection(conn: u64, socket: Socket, events: mpsc::UnboundedSender<Event>, stats: Arc<Stats>) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Out>(OUTBOX);
    let _ = events.send(Event::Open { conn, out: out_tx });
    stats.sockets.fetch_add(1, Ordering::Relaxed);

    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
        loop {
            tokio::select! {
                out = out_rx.recv() => {
                    let mut next = out;
                    loop {
                        match next {
                            Some(Out::Data(data)) if data.len() <= FRAGMENT => {
                                if sink.feed(Message::Binary(data)).await.is_err() {
                                    return;
                                }
                            }
                            Some(Out::Data(data)) => {
                                // One message in several frames: binary, continue..., final.
                                let mut offset = 0;
                                while offset < data.len() {
                                    let end = (offset + FRAGMENT).min(data.len());
                                    let opcode = OpCode::Data(if offset == 0 { Data::Binary } else { Data::Continue });
                                    let frame = Frame::message(data.slice(offset..end), opcode, end == data.len());
                                    if sink.feed(Message::Frame(frame)).await.is_err() {
                                        return;
                                    }
                                    offset = end;
                                }
                            }
                            Some(Out::Close) | None => {
                                let _ = sink.send(Message::Close(None)).await;
                                return;
                            }
                        }
                        match out_rx.try_recv() {
                            Ok(more) => next = Some(more),
                            Err(_) => break,
                        }
                    }
                    if sink.flush().await.is_err() {
                        return;
                    }
                }
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Default::default())).await.is_err() {
                        return;
                    }
                }
            }
        }
    });

    loop {
        match tokio::time::timeout(IDLE, stream.next()).await {
            Ok(Some(Ok(Message::Binary(data)))) => {
                if events.send(Event::Frame { conn, data }).is_err() {
                    break;
                }
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(Some(Err(_))) | Ok(None) | Err(_) => break,
            Ok(Some(Ok(_))) => {} // text, pings and pongs: still alive
        }
    }
    let _ = events.send(Event::Close { conn });
    writer.abort();
    stats.sockets.fetch_sub(1, Ordering::Relaxed);
}

// ------------------------------------------------------------------ static client

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The built client; paths without an extension fall back to index.html (/r/<room>).
async fn static_file(State(s): State<AppState>, uri: Uri) -> Response {
    let root = s.client_dir.as_path();
    if !root.join("index.html").exists() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            "<!doctype html><title>Daystar</title><h1>Almost there</h1><p>Build the client first: <code>bun install &amp;&amp; bun run build</code>.</p>",
        )
            .into_response();
    }
    let path = uri.path();
    let relative = Path::new(path.trim_start_matches('/'));
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) && !path.ends_with('/') && path != "/" {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut target = root.join(relative);
    if target.is_dir() {
        target = target.join("index.html");
    }
    if !target.is_file() && relative.extension().is_none() {
        target = root.join("index.html");
    }
    let Ok(bytes) = tokio::fs::read(&target).await else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    let cache = if path.starts_with("/assets-build/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    let mut res = Response::new(Body::from(bytes));
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(mime(&target)));
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}
