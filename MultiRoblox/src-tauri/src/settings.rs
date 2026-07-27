use crate::paths::settings_path;
use serde_json::{Map, Value};

// Unparseable settings are backed up rather than silently ignored: dropping
// keyVerifier/kdfSalt makes the app forget a passphrase was ever set and offer
// to create a new one, which rotates the salt and orphans every gs:-encrypted
// cookie. Writes stay allowed here (unlike accounts) -- blocking them would
// leave enc_set_key re-encrypting accounts under a key whose verifier never
// reached disk, which is a worse outcome than a reset config.
pub fn load_settings() -> Map<String, Value> {
    crate::jsonfile::read_object(&settings_path())
}

pub fn save_settings(s: &Map<String, Value>) {
    if let Ok(json) = serde_json::to_string_pretty(s) {
        let _ = crate::jsonfile::write_atomic(&settings_path(), &json);
    }
}

pub fn get_str(s: &Map<String, Value>, key: &str) -> Option<String> {
    s.get(key).and_then(|v| v.as_str()).map(|v| v.to_string())
}
