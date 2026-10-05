//! One room: a single task owning all of its state (port of server/src/room.ts,
//! standalone: no replicas, mesh or migration). Connections send it events; it
//! ticks on its own and writes frames into each connection's outbox.

use crate::constants::*;
use crate::protocol::{self, *};
use crate::registry::Registry;
use crate::stats::{Stats, epoch_ms};
use crate::world::*;
use bytes::Bytes;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// Extra distance tolerated per move to absorb network jitter.
const MOVE_SLACK: f64 = 24.0;
const CHAT_BURST: usize = 5;
const CHAT_WINDOW_MS: f64 = 5_000.0;
/// Voice frames held for one tick at most.
const MAX_PENDING_VOICE: usize = 200;

/// What a connection's writer task sends.
pub enum Out {
    Data(Bytes),
    Close,
}

pub type Outbox = mpsc::Sender<Out>;

pub enum Event {
    Open { conn: u64, out: Outbox },
    Frame { conn: u64, data: Bytes },
    Close { conn: u64 },
    SetRate(u32),
}

/// Fx hash: player ids are small integers, SipHash is wasted on them.
#[derive(Default)]
pub struct Fx(u64);
impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.write_u64(*b as u64);
        }
    }
    fn write_u16(&mut self, i: u16) {
        self.write_u64(i as u64);
    }
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}
type FxBuild = BuildHasherDefault<Fx>;
type IdSet = HashSet<u16, FxBuild>;
type IdMap<V> = HashMap<u16, V, FxBuild>;

struct Player {
    id: u16,
    conn: u64,
    name: String,
    appearance: u8,
    x: f64,
    y: f64,
    dir: Dir,
    moving: bool,
    role: Role,
    group: usize,
    /// Map cell of the player's position (area of interest).
    cell: u16,
    last_move_at: f64,
    chat_times: VecDeque<f64>,
    voice_budget: f64,
    voice_at: f64,
}

impl Player {
    fn state(&self) -> PlayerState {
        PlayerState { id: self.id, x: self.x, y: self.y, dir: self.dir, moving: self.moving }
    }
    fn info(&self) -> PlayerInfo {
        PlayerInfo { state: self.state(), name: self.name.clone(), appearance: self.appearance, role: self.role }
    }
}

#[derive(Default)]
struct Pending {
    changed: IdSet,
    voice: Vec<VoiceFrame>,
    voice_since: f64,
    /// Players who joined (described as they are at flush time) and ids that left;
    /// both ride the group's next snapshot.
    joined: Vec<u16>,
    left: Vec<u16>,
}

struct Conn {
    out: Outbox,
    player: Option<u16>,
}

pub struct Room {
    id: String,
    stats: Arc<Stats>,
    secret: Arc<str>,
    registry: Arc<Registry>,
    conn_count: Arc<AtomicUsize>,
    started: Instant,
    players: IdMap<Player>,
    conns: HashMap<u64, Conn>,
    chat: VecDeque<ChatMessage>,
    next_player_id: u32,
    next_chat_id: u32,
    groups: usize,
    tick_hz: u32,
    rate: u32,
    group_sizes: [usize; 2],
    ticks: u64,
    pending: [Pending; 2],
    diverged: bool,
    /// Players by map cell: whom to send each cell's snapshot, and who is in view.
    cells: HashMap<u16, IdSet>,
    ticking: bool,
    retick: bool,
}

impl Room {
    pub fn new(id: String, stats: Arc<Stats>, secret: Arc<str>, registry: Arc<Registry>, conn_count: Arc<AtomicUsize>, rate: u32) -> Room {
        Room {
            id,
            stats,
            secret,
            registry,
            conn_count,
            started: Instant::now(),
            players: IdMap::default(),
            conns: HashMap::new(),
            chat: VecDeque::new(),
            next_player_id: 1,
            next_chat_id: 1,
            groups: 1,
            tick_hz: rate,
            rate,
            group_sizes: [0, 0],
            ticks: 0,
            pending: [Pending::default(), Pending::default()],
            diverged: false,
            cells: HashMap::new(),
            ticking: false,
            retick: false,
        }
    }

    /// Monotonic milliseconds.
    fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    fn snapshot_hz(&self) -> u32 {
        self.tick_hz / self.groups as u32
    }

    /// Most events handled before looking at the clock again. The room does not
    /// yield in between on purpose: on a single thread a yielding room waits behind
    /// thousands of socket tasks and falls behind (measured: joins and ticks stalled).
    const BATCH: usize = 1024;

    pub async fn run(mut self, mut events: mpsc::UnboundedReceiver<Event>) {
        let mut next_tick = tokio::time::Instant::now();
        loop {
            // Wait for an event, or for the next tick.
            let event = if self.ticking {
                tokio::select! {
                    e = events.recv() => e,
                    _ = tokio::time::sleep_until(next_tick) => {
                        self.tick_at(&mut next_tick);
                        continue;
                    }
                }
            } else {
                events.recv().await
            };
            let Some(event) = event else { break };
            if self.process(event, &mut next_tick) {
                break;
            }
            // Then whatever else is queued, in one go: under load this is where the
            // time goes, so no per-event select. Ticks still run on time.
            for _ in 0..Self::BATCH {
                let Ok(event) = events.try_recv() else { break };
                if self.process(event, &mut next_tick) {
                    self.stats.players.fetch_sub(self.players.len() as i64, Ordering::Relaxed);
                    return;
                }
                if self.ticking && tokio::time::Instant::now() >= next_tick {
                    self.tick_at(&mut next_tick);
                }
            }
        }
        self.stats.players.fetch_sub(self.players.len() as i64, Ordering::Relaxed);
    }

    /// Handle one event; true when the room is empty and has been dropped.
    fn process(&mut self, event: Event, next_tick: &mut tokio::time::Instant) -> bool {
        let closed = matches!(event, Event::Close { .. });
        let was_ticking = self.ticking;
        self.handle(event);
        if self.retick || (self.ticking && !was_ticking) {
            *next_tick = tokio::time::Instant::now() + self.period();
            self.retick = false;
        }
        // The last connection left: drop the room unless one is arriving.
        closed && self.conn_count.fetch_sub(1, Ordering::SeqCst) == 1 && self.registry.release_if_empty(&self.id, &self.conn_count)
    }

    fn period(&self) -> Duration {
        Duration::from_secs_f64(1.0 / self.tick_hz.max(1) as f64)
    }

    /// Run a tick and schedule the next; a late room skips ahead instead of bursting.
    fn tick_at(&mut self, next_tick: &mut tokio::time::Instant) {
        self.tick();
        let now = tokio::time::Instant::now();
        *next_tick += self.period();
        if *next_tick < now {
            *next_tick = now + self.period();
        }
    }

    fn handle(&mut self, event: Event) {
        match event {
            Event::Open { conn, out } => {
                self.conns.insert(conn, Conn { out, player: None });
            }
            Event::Frame { conn, data } => {
                let Some(msg) = decode_client(&data) else { return };
                let player = self.conns.get(&conn).and_then(|c| c.player);
                match (msg, player) {
                    (ClientMessage::Move { x, y, dir, moving }, Some(id)) => self.handle_move(id, x, y, dir, moving),
                    (ClientMessage::Join { name, appearance, host_key }, None) => self.join(conn, &name, appearance, &host_key),
                    (ClientMessage::Voice { seq, data }, Some(id)) => self.handle_voice(id, seq, data),
                    (ClientMessage::Chat { text }, Some(id)) => self.handle_chat(id, &text),
                    (ClientMessage::SetRole { id: target, role }, Some(id)) => self.handle_set_role(id, target, role),
                    _ => {}
                }
            }
            Event::Close { conn } => {
                if let Some(Conn { player: Some(id), .. }) = self.conns.remove(&conn) {
                    self.leave(id);
                }
                if self.conns.is_empty() {
                    self.ticking = false;
                }
            }
            Event::SetRate(rate) => {
                self.rate = rate;
                self.apply_schedule(self.players.len());
            }
        }
    }

    // ------------------------------------------------------------ sending

    fn send(&self, conn: u64, data: Bytes) {
        if let Some(c) = self.conns.get(&conn) {
            let depth = c.out.max_capacity() - c.out.capacity();
            // A full outbox means the client is not keeping up: drop, like Bun's backpressure limit.
            let dropped = c.out.try_send(Out::Data(data)).is_err();
            self.stats.record_outbox(depth, dropped);
        }
    }

    fn send_to(&self, id: u16, data: Bytes) {
        if let Some(p) = self.players.get(&id) {
            self.send(p.conn, data);
        }
    }

    fn close(&self, conn: u64) {
        if let Some(c) = self.conns.get(&conn) {
            let _ = c.out.try_send(Out::Close);
        }
    }

    /// Encode once, send to every player.
    fn broadcast(&self, data: Bytes) {
        self.stats.record_egress(data.len() * self.players.len());
        for p in self.players.values() {
            self.send(p.conn, data.clone());
        }
    }

    // ------------------------------------------------------------ players

    fn join(&mut self, conn: u64, raw_name: &str, appearance: u8, host_key: &str) {
        let name = truncate_utf16(raw_name.trim(), MAX_NAME_LENGTH);
        if name.is_empty() {
            self.send(conn, protocol::error("Invalid name or appearance."));
            self.close(conn);
            return;
        }
        let id = self.next_local_id();
        let is_host = !host_key.is_empty() && crate::host_key::is_host_key(&self.id, host_key, &self.secret);
        if is_host {
            self.dethrone_hosts(id);
        }
        let (x, y) = if is_host { WORLD_CENTER } else { self.spawn_for(id) };
        let group = if self.group_sizes[0] <= self.group_sizes[1] { 0 } else { 1 };
        let now = self.now();
        let player = Player {
            id,
            conn,
            name,
            appearance,
            x,
            y,
            dir: Dir::South,
            moving: false,
            role: if is_host { Role::Host } else { Role::Guest },
            group,
            cell: cell_of(x, y),
            last_move_at: now,
            chat_times: VecDeque::new(),
            voice_budget: VOICE_BYTES_PER_SEC,
            voice_at: now,
        };
        // Others hear about a change of snapshot rate before the newcomer's welcome carries it.
        self.apply_schedule(self.players.len() + 1);
        let mut infos: Vec<PlayerInfo> = self.players.values().map(Player::info).collect();
        infos.push(player.info());
        let chat: Vec<ChatMessage> = self.chat.iter().cloned().collect();
        self.send(conn, protocol::welcome(id, &infos, &chat, self.snapshot_hz() as u8));
        // The newcomer hears its own join too; clients skip players they already have.
        for g in &mut self.pending {
            g.joined.push(id);
        }
        self.cells.entry(player.cell).or_default().insert(id);
        self.group_sizes[group] += 1;
        self.players.insert(id, player);
        if let Some(c) = self.conns.get_mut(&conn) {
            c.player = Some(id);
        }
        self.stats.players.fetch_add(1, Ordering::Relaxed);
        if !self.ticking {
            self.ticking = true;
            self.retick = true;
        }
    }

    fn next_local_id(&mut self) -> u16 {
        loop {
            if self.next_player_id > 0xffff {
                self.next_player_id = 1;
            }
            let id = self.next_player_id as u16;
            self.next_player_id += 1;
            if !self.players.contains_key(&id) {
                return id;
            }
        }
    }

    fn leave(&mut self, id: u16) {
        let Some(p) = self.players.remove(&id) else { return };
        if let Some(set) = self.cells.get_mut(&p.cell) {
            set.remove(&id);
            if set.is_empty() {
                self.cells.remove(&p.cell);
            }
        }
        self.group_sizes[p.group] -= 1;
        self.forget(id);
        self.stats.players.fetch_sub(1, Ordering::Relaxed);
        for g in &mut self.pending {
            // A join this group has not been told about yet cancels out instead.
            match g.joined.iter().position(|&j| j == id) {
                Some(i) => {
                    g.joined.swap_remove(i);
                }
                None => g.left.push(id),
            }
        }
        self.apply_schedule(self.players.len());
    }

    /// Somewhere near a player of the room (never the host, who sits in the sun).
    fn spawn_for(&self, id: u16) -> (f64, f64) {
        let others: Vec<(f64, f64)> =
            self.players.values().filter(|p| p.id != id && p.role != Role::Host).map(|p| (p.x, p.y)).collect();
        spawn_point(&others)
    }

    fn dethrone_hosts(&mut self, new_host: u16) {
        let hosts: Vec<u16> = self.players.values().filter(|p| p.role == Role::Host && p.id != new_host).map(|p| p.id).collect();
        for id in hosts {
            self.apply_role(id, Role::Guest);
        }
    }

    fn handle_set_role(&mut self, requester: u16, target: u16, role: Role) {
        if self.players.get(&requester).map(|p| p.role) != Some(Role::Host) {
            self.send_to(requester, protocol::error("Only the host can choose speakers."));
            return;
        }
        let Some(current) = self.players.get(&target).map(|p| p.role) else { return };
        if current == Role::Host || current == role {
            return;
        }
        let speakers = self.players.values().filter(|p| p.role == Role::Speaker).count();
        if role == Role::Speaker && speakers >= MAX_SPEAKERS {
            self.send_to(requester, protocol::error(&format!("There can be at most {MAX_SPEAKERS} speakers.")));
            return;
        }
        self.apply_role(target, role);
    }

    fn apply_role(&mut self, id: u16, role: Role) {
        let Some(p) = self.players.get_mut(&id) else { return };
        if p.role == role {
            return;
        }
        let was_host = p.role == Role::Host;
        p.role = role;
        if was_host {
            // A former host leaves the sun for a spot near the others.
            let (x, y) = self.spawn_for(id);
            let now = self.now();
            let p = self.players.get_mut(&id).unwrap();
            p.x = x;
            p.y = y;
            p.last_move_at = now;
            self.mark_changed(id);
            self.send_to(id, protocol::correction(x, y));
            self.update_cell(id);
        }
        self.broadcast(protocol::role(id, role));
    }

    fn handle_move(&mut self, id: u16, x: f64, y: f64, dir: Dir, moving: bool) {
        let now = self.now();
        let p = self.players.get_mut(&id).unwrap();
        if p.role == Role::Host {
            return; // the sun does not move
        }
        let elapsed = ((now - p.last_move_at) / 1000.0).min(1.0);
        let max_distance = MOVE_SPEED * elapsed + MOVE_SLACK;
        let (dx, dy) = (x - p.x, y - p.y);
        if dx * dx + dy * dy > max_distance * max_distance || !can_be_at(x, y) {
            let (cx, cy, conn) = (p.x, p.y, p.conn);
            self.send(conn, protocol::correction(cx, cy));
            return;
        }
        p.x = x;
        p.y = y;
        p.dir = dir;
        p.moving = moving;
        p.last_move_at = now;
        self.mark_changed(id);
        self.update_cell(id);
    }

    fn handle_voice(&mut self, id: u16, seq: u16, data: Bytes) {
        let now = self.now();
        let p = self.players.get_mut(&id).unwrap();
        if !p.role.can_speak() || data.is_empty() || data.len() > MAX_VOICE_FRAME_BYTES {
            return;
        }
        p.voice_budget = (p.voice_budget + (now - p.voice_at) / 1000.0 * VOICE_BYTES_PER_SEC).min(VOICE_BYTES_PER_SEC);
        p.voice_at = now;
        if p.voice_budget < data.len() as f64 {
            return;
        }
        p.voice_budget -= data.len() as f64;
        let frame = VoiceFrame { id, seq, data };
        for g in &mut self.pending {
            if g.voice.len() >= MAX_PENDING_VOICE {
                continue;
            }
            if g.voice.is_empty() {
                g.voice_since = now;
            }
            g.voice.push(frame.clone());
        }
    }

    fn handle_chat(&mut self, id: u16, raw: &str) {
        let text = truncate_utf16(raw.trim(), MAX_CHAT_LENGTH);
        if text.is_empty() {
            return;
        }
        let now = self.now();
        let p = self.players.get_mut(&id).unwrap();
        while p.chat_times.front().is_some_and(|t| now - t >= CHAT_WINDOW_MS) {
            p.chat_times.pop_front();
        }
        if p.chat_times.len() >= CHAT_BURST {
            let conn = p.conn;
            self.send(conn, protocol::error("You are sending messages too fast."));
            return;
        }
        p.chat_times.push_back(now);
        let message = ChatMessage { id: self.next_chat_id % 0x100_0000, player_id: id, name: p.name.clone(), text, ts: epoch_ms().round() };
        self.next_chat_id = self.next_chat_id.wrapping_add(1);
        self.chat.push_back(message.clone());
        if self.chat.len() > CHAT_HISTORY_SIZE {
            self.chat.pop_front();
        }
        self.broadcast(protocol::chat(&message));
    }

    // ------------------------------------------------------------ schedule

    /// Two groups from SNAPSHOT_GROUPS_AT players (back to one below
    /// SNAPSHOT_GROUPS_OFF_BELOW), ticking groups x the per-player rate.
    fn apply_schedule(&mut self, count: usize) {
        let groups = if self.groups == 1 {
            if count >= SNAPSHOT_GROUPS_AT { 2 } else { 1 }
        } else if count < SNAPSHOT_GROUPS_OFF_BELOW {
            1
        } else {
            2
        };
        let per_player = if count >= OVERCHARGE_FORCE_AT { self.rate.min(TICK_RATE / 2) } else { self.rate };
        let before = self.snapshot_hz();
        self.groups = groups;
        if per_player * groups as u32 != self.tick_hz {
            self.tick_hz = per_player * groups as u32;
            self.retick = true;
        }
        if self.snapshot_hz() != before {
            self.broadcast(protocol::rate(self.snapshot_hz() as u8));
        }
    }

    fn mark_changed(&mut self, id: u16) {
        for g in &mut self.pending {
            g.changed.insert(id);
        }
    }

    fn forget(&mut self, id: u16) {
        for g in &mut self.pending {
            g.changed.remove(&id);
        }
    }

    // ------------------------------------------------------------ area of interest

    /// A player moved: when it enters another cell it gets everyone in the part of
    /// the map that just came into view, idle players included.
    fn update_cell(&mut self, id: u16) {
        let p = &self.players[&id];
        let (from, to) = (p.cell, cell_of(p.x, p.y));
        if from == to {
            return;
        }
        if let Some(set) = self.cells.get_mut(&from) {
            set.remove(&id);
            if set.is_empty() {
                self.cells.remove(&from);
            }
        }
        self.cells.entry(to).or_default().insert(id);
        self.players.get_mut(&id).unwrap().cell = to;
        let mut band = Vec::new();
        for &near in cells_in_view(to) {
            // Cells the old view covered entirely hold nobody new.
            if cell_fully_in_view(near, from) {
                continue;
            }
            let Some(ids) = self.cells.get(&near) else { continue };
            for q in ids {
                let q = &self.players[q];
                if q.id != id && in_view(q.x, q.y, to) && !in_view(q.x, q.y, from) {
                    band.push(q.state());
                }
            }
        }
        self.send_to(id, protocol::view(from, to, &band));
    }

    // ------------------------------------------------------------ ticks

    fn tick(&mut self) {
        let start = Instant::now();
        let now = self.now();
        self.ticks += 1;
        let sent = if self.groups == 2 {
            self.diverged = true;
            self.flush(&[(self.ticks % 2) as usize], now)
        } else if self.diverged {
            self.diverged = false;
            let a = self.flush(&[0], now);
            self.flush(&[1], now) || a
        } else {
            self.flush(&[0, 1], now)
        };
        if sent {
            self.stats.record_tick(start.elapsed().as_secs_f64() * 1000.0);
        }
    }

    /// One snapshot per map cell with players in the due groups: the changed
    /// players in view of that cell, the host and speakers wherever they are, and
    /// the voice. Groups listed together have identical pending state.
    fn flush(&mut self, groups: &[usize], now: f64) -> bool {
        let p = &self.pending[groups[0]];
        let period = 1000.0 / self.snapshot_hz() as f64;
        let voice_due = !p.voice.is_empty() && (!p.changed.is_empty() || now - p.voice_since + period >= VOICE_FLUSH_MS);
        let roster = !p.joined.is_empty() || !p.left.is_empty();
        if p.changed.is_empty() && !voice_due && !roster {
            return false;
        }
        let joined: Vec<PlayerInfo> = p.joined.iter().filter_map(|id| self.players.get(id)).map(Player::info).collect();
        let tail = protocol::snapshot_tail(if voice_due { &p.voice } else { &[] }, &joined, &p.left);
        let has_tail = voice_due || roster;

        let mut stage: Vec<[u8; 7]> = Vec::new();
        let mut by_cell: HashMap<u16, Vec<(f64, f64, [u8; 7])>, FxBuild> = HashMap::default();
        for id in &p.changed {
            let Some(q) = self.players.get(id) else { continue };
            let entry = protocol::snapshot_entry(&q.state());
            if q.role != Role::Guest {
                stage.push(entry);
            } else {
                by_cell.entry(cell_of(q.x, q.y)).or_default().push((q.x, q.y, entry));
            }
        }

        let mut entries: Vec<[u8; 7]> = Vec::new();
        for (&cell, ids) in &self.cells {
            let recipients = ids.iter().filter(|id| groups.contains(&self.players[id].group)).count();
            if recipients == 0 {
                continue;
            }
            entries.clear();
            entries.extend_from_slice(&stage);
            let near = cells_in_view(cell);
            if by_cell.len() < near.len() {
                for (&other, movers) in &by_cell {
                    if cells_meet(cell, other) {
                        entries.extend(movers.iter().filter(|m| in_view(m.0, m.1, cell)).map(|m| m.2));
                    }
                }
            } else {
                for other in near {
                    if let Some(movers) = by_cell.get(other) {
                        entries.extend(movers.iter().filter(|m| in_view(m.0, m.1, cell)).map(|m| m.2));
                    }
                }
            }
            if entries.is_empty() && !has_tail {
                continue;
            }
            let data = protocol::assemble_snapshot(&entries, &tail);
            self.stats.record_egress(data.len() * recipients);
            for id in ids {
                let q = &self.players[id];
                if groups.contains(&q.group) {
                    self.send(q.conn, data.clone());
                }
            }
        }
        for &g in groups {
            self.pending[g].changed.clear();
            self.pending[g].joined.clear();
            self.pending[g].left.clear();
            if voice_due {
                self.pending[g].voice.clear();
            }
        }
        true
    }
}

/// Like JavaScript's `slice(0, n)`: at most `n` UTF-16 code units.
fn truncate_utf16(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}
