//! Rooms and their hosts without storing anything (server/src/host-key.ts): the
//! server picks a fresh room id and hands its creator HMAC(secret, "host:" + room).

use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use rand::RngExt;
use sha2::Sha256;

const ADJECTIVES: [&str; 10] = ["amber", "bright", "calm", "cosmic", "golden", "lunar", "quiet", "radiant", "silver", "velvet"];
const NOUNS: [&str; 10] = ["comet", "nebula", "orbit", "aurora", "eclipse", "quasar", "zenith", "meteor", "galaxy", "halo"];
const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";

/// e.g. "golden-comet-k3x9q2".
pub fn new_room_id() -> String {
    let mut rng = rand::rng();
    let tail: String = (0..6).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect();
    format!("{}-{}-{tail}", ADJECTIVES[rng.random_range(0..10)], NOUNS[rng.random_range(0..10)])
}

pub fn host_key_for(room: &str, secret: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(format!("host:{room}").as_bytes());
    let digest = mac.finalize().into_bytes();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&digest[..18])
}

pub fn is_host_key(room: &str, key: &str, secret: &str) -> bool {
    let expected = host_key_for(room, secret);
    let (a, b) = (expected.as_bytes(), key.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// ROOM_SECRET, or a random secret (hosts then lose their rooms on restart).
pub fn secret_from_env() -> String {
    if let Ok(s) = std::env::var("ROOM_SECRET") {
        if !s.is_empty() {
            return s;
        }
    }
    eprintln!("warning: ROOM_SECRET is not set; hosts lose their rooms when the server restarts");
    let mut rng = rand::rng();
    (0..32).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_open_only_their_room() {
        let key = host_key_for("golden-comet-abc", "s1");
        assert!(is_host_key("golden-comet-abc", &key, "s1"));
        assert!(!is_host_key("golden-comet-abd", &key, "s1"));
        assert!(!is_host_key("golden-comet-abc", &key, "s2"));
        assert!(!is_host_key("golden-comet-abc", "", "s1"));
        assert_eq!(key.len(), 24);
    }

    #[test]
    fn same_key_as_the_typescript_server() {
        // node: createHmac("sha256","s1").update("host:golden-comet-abc").digest().subarray(0,18).toString("base64url")
        assert_eq!(host_key_for("golden-comet-abc", "s1"), include_str!("../fixtures/host-key.txt").trim());
    }
}
