//! Rooms by id. A room is created by its first connection and drops itself when
//! its last connection closes (unless one is arriving at that very moment).

use crate::room::{Event, Room};
use crate::stats::Stats;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

struct Handle {
    events: mpsc::UnboundedSender<Event>,
    /// Connections attached to the room, counted before their Open event arrives.
    conns: Arc<AtomicUsize>,
}

pub struct Registry {
    rooms: Mutex<HashMap<String, Handle>>,
    stats: Arc<Stats>,
    secret: Arc<str>,
}

impl Registry {
    pub fn new(stats: Arc<Stats>, secret: Arc<str>) -> Arc<Registry> {
        Arc::new(Registry { rooms: Mutex::new(HashMap::new()), stats, secret })
    }

    /// The room's event channel for a new connection (creating the room if needed).
    pub fn acquire(self: &Arc<Self>, room: &str) -> mpsc::UnboundedSender<Event> {
        let mut rooms = self.rooms.lock().unwrap();
        let handle = rooms.entry(room.to_string()).or_insert_with(|| {
            let (tx, rx) = mpsc::unbounded_channel();
            let conns = Arc::new(AtomicUsize::new(0));
            let rate = self.stats.rate.load(Ordering::Relaxed);
            let actor = Room::new(room.to_string(), self.stats.clone(), self.secret.clone(), self.clone(), conns.clone(), rate);
            tokio::spawn(actor.run(rx));
            self.stats.rooms.fetch_add(1, Ordering::Relaxed);
            Handle { events: tx, conns }
        });
        handle.conns.fetch_add(1, Ordering::SeqCst);
        handle.events.clone()
    }

    /// Called by a room whose last connection closed; true when it was removed.
    pub fn release_if_empty(&self, room: &str, conns: &AtomicUsize) -> bool {
        let mut rooms = self.rooms.lock().unwrap();
        if conns.load(Ordering::SeqCst) != 0 {
            return false;
        }
        rooms.remove(room);
        self.stats.rooms.fetch_sub(1, Ordering::Relaxed);
        true
    }

    /// The overcharge changed the snapshot rate: tell every room.
    pub fn set_rate(&self, rate: u32) {
        for handle in self.rooms.lock().unwrap().values() {
            let _ = handle.events.send(Event::SetRate(rate));
        }
    }
}
