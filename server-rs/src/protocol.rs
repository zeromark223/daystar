//! The binary wire protocol, byte-compatible with shared/src/protocol.ts: one
//! opcode byte, then fields in little-endian order; strings are UTF-8 with a
//! UInt16 byte length, lists carry a UInt8 or UInt16 count.

use bytes::Bytes;

/// Positions travel as UInt16 in quarter-pixel steps.
pub const POSITION_SCALE: f64 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    South = 0,
    West = 1,
    East = 2,
    North = 3,
}

impl Dir {
    fn from_bits(bits: u8) -> Dir {
        match bits & 3 {
            0 => Dir::South,
            1 => Dir::West,
            2 => Dir::East,
            _ => Dir::North,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Guest = 0,
    Speaker = 1,
    Host = 2,
}

impl Role {
    pub fn can_speak(self) -> bool {
        self != Role::Guest
    }
    fn from_index(i: u8) -> Option<Role> {
        match i {
            0 => Some(Role::Guest),
            1 => Some(Role::Speaker),
            2 => Some(Role::Host),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlayerState {
    pub id: u16,
    pub x: f64,
    pub y: f64,
    pub dir: Dir,
    pub moving: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlayerInfo {
    pub state: PlayerState,
    pub name: String,
    pub appearance: u8,
    pub role: Role,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChatMessage {
    pub id: u32,
    pub player_id: u16,
    pub name: String,
    pub text: String,
    /// Unix epoch milliseconds.
    pub ts: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VoiceFrame {
    pub id: u16,
    pub seq: u16,
    pub data: Bytes,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClientMessage {
    Join { name: String, appearance: u8, host_key: String },
    Chat { text: String },
    Move { x: f64, y: f64, dir: Dir, moving: bool },
    /// Host only; `role` is Speaker or Guest.
    SetRole { id: u16, role: Role },
    Voice { seq: u16, data: Bytes },
}

mod op {
    pub const JOIN: u8 = 1;
    pub const CHAT: u8 = 2;
    pub const MOVE: u8 = 3;
    pub const SET_ROLE: u8 = 4;
    pub const VOICE: u8 = 5;
    pub const WELCOME: u8 = 10;
    #[allow(dead_code)]
    pub const PLAYER_JOINED: u8 = 11;
    #[allow(dead_code)]
    pub const PLAYER_LEFT: u8 = 12;
    pub const CHAT_OUT: u8 = 13;
    pub const CORRECTION: u8 = 14;
    pub const ERROR: u8 = 15;
    pub const SNAPSHOT: u8 = 16;
    #[allow(dead_code)]
    pub const MIGRATE: u8 = 17;
    pub const ROLE: u8 = 18;
    pub const RATE: u8 = 19;
    pub const VIEW: u8 = 20;
}

fn to_wire(v: f64) -> u16 {
    (v * POSITION_SCALE).round().clamp(0.0, 65_535.0) as u16
}

fn from_wire(v: u16) -> f64 {
    v as f64 / POSITION_SCALE
}

fn pack_motion(dir: Dir, moving: bool) -> u8 {
    dir as u8 | if moving { 4 } else { 0 }
}

// ------------------------------------------------------------------ writing

struct W(Vec<u8>);

impl W {
    fn new(op: u8, capacity: usize) -> W {
        let mut v = Vec::with_capacity(capacity + 1);
        v.push(op);
        W(v)
    }
    fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
    fn u16(&mut self, v: u16) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn f64(&mut self, v: f64) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn str(&mut self, s: &str) -> &mut Self {
        let b = s.as_bytes();
        let len = b.len().min(0xffff);
        self.u16(len as u16);
        self.0.extend_from_slice(&b[..len]);
        self
    }
    fn state(&mut self, p: &PlayerState) -> &mut Self {
        self.u16(p.id).u16(to_wire(p.x)).u16(to_wire(p.y)).u8(pack_motion(p.dir, p.moving))
    }
    fn info(&mut self, p: &PlayerInfo) -> &mut Self {
        self.state(&p.state).str(&p.name).u8(p.appearance).u8(p.role as u8)
    }
    fn chat(&mut self, c: &ChatMessage) -> &mut Self {
        self.u32(c.id).u16(c.player_id).str(&c.name).str(&c.text).f64(c.ts)
    }
    fn done(self) -> Bytes {
        Bytes::from(self.0)
    }
}

pub fn welcome(self_id: u16, players: &[PlayerInfo], chat: &[ChatMessage], snapshot_hz: u8) -> Bytes {
    let mut w = W::new(op::WELCOME, 8 + players.len() * 24);
    w.u16(self_id).u16(players.len() as u16);
    for p in players {
        w.info(p);
    }
    w.u8(chat.len() as u8);
    for c in chat {
        w.chat(c);
    }
    w.u8(snapshot_hz);
    w.done()
}

/// Not sent any more (joins ride snapshots); kept so the wire format stays complete.
#[allow(dead_code)]
pub fn player_joined(p: &PlayerInfo) -> Bytes {
    let mut w = W::new(op::PLAYER_JOINED, 32);
    w.info(p);
    w.done()
}

#[allow(dead_code)]
pub fn player_left(id: u16) -> Bytes {
    let mut w = W::new(op::PLAYER_LEFT, 2);
    w.u16(id);
    w.done()
}

pub fn chat(c: &ChatMessage) -> Bytes {
    let mut w = W::new(op::CHAT_OUT, 32 + c.text.len());
    w.chat(c);
    w.done()
}

pub fn correction(x: f64, y: f64) -> Bytes {
    let mut w = W::new(op::CORRECTION, 4);
    w.u16(to_wire(x)).u16(to_wire(y));
    w.done()
}

pub fn error(message: &str) -> Bytes {
    let mut w = W::new(op::ERROR, 2 + message.len());
    w.str(message);
    w.done()
}

/// Cluster only (not served here); kept so the protocol is complete and tested.
#[allow(dead_code)]
pub fn migrate() -> Bytes {
    W::new(op::MIGRATE, 0).done()
}

pub fn role(id: u16, role: Role) -> Bytes {
    let mut w = W::new(op::ROLE, 3);
    w.u16(id).u8(role as u8);
    w.done()
}

pub fn rate(snapshot_hz: u8) -> Bytes {
    let mut w = W::new(op::RATE, 1);
    w.u8(snapshot_hz);
    w.done()
}

pub fn view(from: u16, to: u16, players: &[PlayerState]) -> Bytes {
    let mut w = W::new(op::VIEW, 6 + players.len() * 7);
    w.u16(from).u16(to).u16(players.len() as u16);
    for p in players {
        w.state(p);
    }
    w.done()
}

// ------------------------------------------------------------ snapshots by parts

/// One player's 7-byte snapshot entry, encoded once per tick and copied into the
/// snapshot of every map cell that sees the player (area of interest).
pub fn snapshot_entry(p: &PlayerState) -> [u8; 7] {
    let x = to_wire(p.x).to_le_bytes();
    let y = to_wire(p.y).to_le_bytes();
    let id = p.id.to_le_bytes();
    [id[0], id[1], x[0], x[1], y[0], y[1], pack_motion(p.dir, p.moving)]
}

/// What ends a snapshot after the entries: voice frames (UInt8 count, then
/// {id, seq, len, data}), players who joined (UInt16 count of PlayerInfo) and
/// ids that left (UInt16 count of UInt16). Encoded once per group per tick.
pub fn snapshot_tail(frames: &[VoiceFrame], joined: &[PlayerInfo], left: &[u16]) -> Vec<u8> {
    let cap = 5 + frames.iter().map(|f| 6 + f.data.len()).sum::<usize>() + joined.len() * 24 + left.len() * 2;
    let mut w = W(Vec::with_capacity(cap));
    w.u8(frames.len() as u8);
    for f in frames {
        w.u16(f.id).u16(f.seq).u16(f.data.len() as u16);
        w.0.extend_from_slice(&f.data);
    }
    w.u16(joined.len() as u16);
    for p in joined {
        w.info(p);
    }
    w.u16(left.len() as u16);
    for &id in left {
        w.u16(id);
    }
    w.0
}

pub fn assemble_snapshot(entries: &[[u8; 7]], tail: &[u8]) -> Bytes {
    let mut out = Vec::with_capacity(3 + entries.len() * 7 + tail.len());
    out.push(op::SNAPSHOT);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for e in entries {
        out.extend_from_slice(e);
    }
    out.extend_from_slice(tail);
    Bytes::from(out)
}

// ------------------------------------------------------------------ reading

struct R<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.pos..self.pos + n)?;
        self.pos += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        let s = self.take(2)?;
        Some(u16::from_le_bytes([s[0], s[1]]))
    }
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.u16()? as usize;
        self.take(len)
    }
    fn str(&mut self) -> Option<String> {
        Some(String::from_utf8_lossy(self.bytes()?).into_owned())
    }
    /// Frames with trailing bytes are malformed.
    fn end(&self) -> Option<()> {
        (self.pos == self.b.len()).then_some(())
    }
}

/// None for malformed or unknown frames (client input is untrusted).
pub fn decode_client(frame: &[u8]) -> Option<ClientMessage> {
    let (&opcode, _) = frame.split_first()?;
    let mut r = R { b: frame, pos: 1 };
    let msg = match opcode {
        op::JOIN => {
            let name = r.str()?;
            let appearance = r.u8()?;
            let host_key = r.str()?;
            if appearance >= crate::constants::APPEARANCE_COUNT {
                return None;
            }
            ClientMessage::Join { name, appearance, host_key }
        }
        op::CHAT => ClientMessage::Chat { text: r.str()? },
        op::MOVE => {
            let x = from_wire(r.u16()?);
            let y = from_wire(r.u16()?);
            let motion = r.u8()?;
            if motion > 7 {
                return None;
            }
            ClientMessage::Move { x, y, dir: Dir::from_bits(motion), moving: motion & 4 != 0 }
        }
        op::SET_ROLE => {
            let id = r.u16()?;
            let role = Role::from_index(r.u8()?)?;
            if role == Role::Host {
                return None;
            }
            ClientMessage::SetRole { id, role }
        }
        op::VOICE => {
            let seq = r.u16()?;
            let data = Bytes::copy_from_slice(r.bytes()?);
            ClientMessage::Voice { seq, data }
        }
        _ => return None,
    };
    r.end()?;
    Some(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    fn fixtures() -> Value {
        serde_json::from_str(include_str!("../fixtures/protocol.json")).unwrap()
    }
    fn dir(v: &Value) -> Dir {
        match v.as_str().unwrap() {
            "south" => Dir::South,
            "west" => Dir::West,
            "east" => Dir::East,
            _ => Dir::North,
        }
    }
    fn role_of(v: &Value) -> Role {
        match v.as_str().unwrap() {
            "guest" => Role::Guest,
            "speaker" => Role::Speaker,
            _ => Role::Host,
        }
    }
    fn state(v: &Value) -> PlayerState {
        PlayerState {
            id: v["id"].as_u64().unwrap() as u16,
            x: v["x"].as_f64().unwrap(),
            y: v["y"].as_f64().unwrap(),
            dir: dir(&v["dir"]),
            moving: v["moving"].as_bool().unwrap(),
        }
    }
    fn info(v: &Value) -> PlayerInfo {
        PlayerInfo {
            state: state(v),
            name: v["name"].as_str().unwrap().into(),
            appearance: v["appearance"].as_u64().unwrap() as u8,
            role: role_of(&v["role"]),
        }
    }
    fn chat_of(v: &Value) -> ChatMessage {
        ChatMessage {
            id: v["id"].as_u64().unwrap() as u32,
            player_id: v["playerId"].as_u64().unwrap() as u16,
            name: v["name"].as_str().unwrap().into(),
            text: v["text"].as_str().unwrap().into(),
            ts: v["ts"].as_f64().unwrap(),
        }
    }
    fn u16_of(v: &Value) -> u16 {
        v.as_u64().unwrap() as u16
    }

    #[test]
    fn server_messages_match_the_typescript_encoder() {
        let f = fixtures();
        for case in f["server"].as_array().unwrap() {
            let m = &case["message"];
            let encoded = match m["t"].as_str().unwrap() {
                "welcome" => welcome(
                    u16_of(&m["selfId"]),
                    &m["players"].as_array().unwrap().iter().map(info).collect::<Vec<_>>(),
                    &m["chat"].as_array().unwrap().iter().map(chat_of).collect::<Vec<_>>(),
                    m["snapshotHz"].as_u64().unwrap() as u8,
                ),
                "player_joined" => player_joined(&info(&m["player"])),
                "player_left" => player_left(u16_of(&m["id"])),
                "chat" => chat(&chat_of(&m["message"])),
                "correction" => correction(m["x"].as_f64().unwrap(), m["y"].as_f64().unwrap()),
                "error" => error(m["message"].as_str().unwrap()),
                "snapshot" => {
                    let entries: Vec<_> = m["players"].as_array().unwrap().iter().map(|p| snapshot_entry(&state(p))).collect();
                    let frames: Vec<_> = m["voice"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| VoiceFrame {
                            id: u16_of(&v["id"]),
                            seq: u16_of(&v["seq"]),
                            data: Bytes::from(v["data"].as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect::<Vec<_>>()),
                        })
                        .collect();
                    let joined: Vec<_> = m["joined"].as_array().unwrap().iter().map(info).collect();
                    let left: Vec<_> = m["left"].as_array().unwrap().iter().map(u16_of).collect();
                    assemble_snapshot(&entries, &snapshot_tail(&frames, &joined, &left))
                }
                "role" => role(u16_of(&m["id"]), role_of(&m["role"])),
                "rate" => rate(m["snapshotHz"].as_u64().unwrap() as u8),
                "view" => view(
                    u16_of(&m["from"]),
                    u16_of(&m["to"]),
                    &m["players"].as_array().unwrap().iter().map(state).collect::<Vec<_>>(),
                ),
                "migrate" => migrate(),
                other => panic!("unknown fixture {other}"),
            };
            assert_eq!(hex(&encoded), case["hex"].as_str().unwrap(), "{}", m["t"]);
        }
    }

    #[test]
    fn client_frames_decode_like_typescript() {
        let f = fixtures();
        for case in f["client"].as_array().unwrap() {
            let m = &case["message"];
            let got = decode_client(&unhex(case["hex"].as_str().unwrap())).expect("decodes");
            let want = match m["t"].as_str().unwrap() {
                "join" => ClientMessage::Join {
                    name: m["name"].as_str().unwrap().into(),
                    appearance: m["appearance"].as_u64().unwrap() as u8,
                    host_key: m["hostKey"].as_str().unwrap().into(),
                },
                "chat" => ClientMessage::Chat { text: m["text"].as_str().unwrap().into() },
                "move" => ClientMessage::Move {
                    x: m["x"].as_f64().unwrap(),
                    y: m["y"].as_f64().unwrap(),
                    dir: dir(&m["dir"]),
                    moving: m["moving"].as_bool().unwrap(),
                },
                "set_role" => ClientMessage::SetRole { id: u16_of(&m["id"]), role: role_of(&m["role"]) },
                "voice" => ClientMessage::Voice {
                    seq: u16_of(&m["seq"]),
                    data: Bytes::from(m["data"].as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect::<Vec<_>>()),
                },
                other => panic!("unknown fixture {other}"),
            };
            assert_eq!(got, want);
        }
    }

    #[test]
    fn malformed_client_frames_are_rejected() {
        for case in fixtures()["badClient"].as_array().unwrap() {
            assert_eq!(decode_client(&unhex(case.as_str().unwrap())), None, "{case}");
        }
    }
}
