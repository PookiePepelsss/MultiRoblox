// Port of main.js's key-session logic (getEncryptionKey/getLegacyKey/
// encryptField/decryptField/passphraseMode). Ciphertext tags (gs:/gcm:/cbc:/
// safe:) are unchanged so records written by the Electron build keep
// decrypting here. New writes use "safe2:" (plain DPAPI, no Local State
// dependency) instead of Electron's Chromium-flavoured "safe:"; see
// crypto.rs for why.
use crate::crypto;
use crate::paths::local_state_path;
use crate::settings::{get_str, load_settings, save_settings};
use crate::state::AppState;
use rand::RngCore;
use serde_json::Value;
use tauri::Manager;

const VERIFY_TOKEN: &str = "multiroblox-verify-v1";

pub fn passphrase_mode() -> bool {
    let s = load_settings();
    let has_verifier = s
        .get("keyVerifier")
        .and_then(|v| v.as_str())
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let has_key_enc = s
        .get("customKeyEnc")
        .and_then(|v| v.as_str())
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let has_key = s
        .get("customKey")
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    has_verifier || has_key_enc || has_key
}

fn current_salt() -> String {
    get_str(&load_settings(), "kdfSalt").unwrap_or_else(|| crypto::LEGACY_SALT.to_string())
}

/// Fresh random salt for the scrypt key; only called from enc_set_key,
/// which re-encrypts every account right after, so rotating here can never
/// strand ciphertext under a salt nothing can derive anymore.
pub fn rotate_salt() {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut s = load_settings();
    s.insert("kdfSalt".into(), Value::String(hex::encode(bytes)));
    save_settings(&s);
}

pub fn make_verifier(pass: &str) -> String {
    let key = crypto::derive_scrypt_key(pass, &current_salt());
    crypto::encrypt_gcm(VERIFY_TOKEN, &key, "gs")
}

pub fn verify_pass(pass: &str) -> bool {
    let s = load_settings();
    match s.get("keyVerifier").and_then(|v| v.as_str()) {
        Some(v) => {
            let key = crypto::derive_scrypt_key(pass, &current_salt());
            crypto::decrypt_gcm(v, &key, "gs").as_deref() == Some(VERIFY_TOKEN)
        }
        None => false,
    }
}

fn get_or_create_device_key() -> [u8; 32] {
    let mut s = load_settings();
    if let Some(k) = s.get("_deviceKey").and_then(|v| v.as_str()) {
        if let Ok(bytes) = hex::decode(k) {
            if bytes.len() == 32 {
                let mut out = [0u8; 32];
                out.copy_from_slice(&bytes);
                return out;
            }
        }
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    s.insert("_deviceKey".into(), Value::String(hex::encode(key)));
    save_settings(&s);
    key
}

fn safe_storage_ready() -> bool {
    cfg!(windows)
}

pub fn get_encryption_key(state: &AppState) -> Option<[u8; 32]> {
    if let Some(k) = *state.cached_key.lock().unwrap() {
        return Some(k);
    }
    let session_pass = state.session_pass.lock().unwrap().clone();
    if let Some(pass) = session_pass {
        let k = crypto::derive_scrypt_key(&pass, &current_salt());
        *state.cached_key.lock().unwrap() = Some(k);
        return Some(k);
    }
    if !passphrase_mode() {
        let k = get_or_create_device_key();
        *state.cached_key.lock().unwrap() = Some(k);
        return Some(k);
    }
    None // locked
}

pub fn get_legacy_key(state: &AppState) -> Option<[u8; 32]> {
    if let Some(k) = *state.cached_legacy_key.lock().unwrap() {
        return Some(k);
    }
    let session_pass = state.session_pass.lock().unwrap().clone();
    if let Some(pass) = session_pass {
        let k = crypto::derive_legacy_key(&pass);
        *state.cached_legacy_key.lock().unwrap() = Some(k);
        return Some(k);
    }
    if !passphrase_mode() {
        let k = get_or_create_device_key();
        *state.cached_legacy_key.lock().unwrap() = Some(k);
        return Some(k);
    }
    None
}

pub fn invalidate_key_cache(state: &AppState) {
    *state.cached_key.lock().unwrap() = None;
    *state.cached_legacy_key.lock().unwrap() = None;
}

/// Pre-derives the unlocked passphrase key off the async runtime's blocking
/// pool so the first decrypt hits the cache instead of blocking on a
/// ~340ms scrypt derive. No-op when locked or machine-bound.
pub fn prewarm_key(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let already = state.cached_key.lock().unwrap().is_some();
        let session_pass = state.session_pass.lock().unwrap().clone();
        let Some(pass) = (if already { None } else { session_pass }) else {
            return;
        };
        let salt = current_salt();
        let key = tokio::task::spawn_blocking(move || crypto::derive_scrypt_key(&pass, &salt))
            .await
            .ok();
        if let Some(key) = key {
            let mut cached = state.cached_key.lock().unwrap();
            if cached.is_none() {
                *cached = Some(key);
            }
        }
    });
}

pub fn is_encrypted(v: &str) -> bool {
    v.starts_with("safe2:")
        || v.starts_with("safe:")
        || v.starts_with("gs:")
        || v.starts_with("gcm:")
        || v.starts_with("cbc:")
}

pub fn encrypt_field(state: &AppState, plaintext: &str) -> Result<String, String> {
    let session_pass = state.session_pass.lock().unwrap().clone();
    if session_pass.is_some() {
        let key = get_encryption_key(state).ok_or("locked")?;
        return Ok(crypto::encrypt_gcm(plaintext, &key, "gs"));
    }
    if passphrase_mode() {
        return Err("locked".into());
    }
    if safe_storage_ready() {
        if let Some(enc) = crypto::encrypt_safe2(plaintext) {
            return Ok(enc);
        }
    }
    let key = get_encryption_key(state).ok_or("locked")?;
    Ok(crypto::encrypt_gcm(plaintext, &key, "gs"))
}

pub fn decrypt_field(state: &AppState, ct: &str) -> Option<String> {
    if ct.is_empty() {
        return None;
    }
    if ct.starts_with("safe2:") {
        return crypto::decrypt_safe2(ct);
    }
    if ct.starts_with("safe:") {
        let body = ct.strip_prefix("safe:")?;
        return crypto::decrypt_electron_safe_storage(body, &local_state_path());
    }
    if ct.starts_with("gs:") {
        return crypto::decrypt_gcm(ct, &get_encryption_key(state)?, "gs");
    }
    if ct.starts_with("gcm:") {
        return crypto::decrypt_gcm(ct, &get_legacy_key(state)?, "gcm");
    }
    if ct.starts_with("cbc:") {
        return crypto::decrypt_cbc(ct, &get_legacy_key(state)?);
    }
    Some(ct.to_string())
}

/// Runs once at startup: migrate legacy customKey/customKeyEnc formats to the
/// verifier model. Unlike the old Electron build's per-boot session cache,
/// this app asks for the passphrase on every launch (writeSessionKey was
/// already disabled in the source main.js).
pub fn init_encryption(state: &AppState) {
    let s = load_settings();
    if s.get("keyVerifier").and_then(|v| v.as_str()).is_none() {
        let mut legacy: Option<String> = None;
        if let Some(enc) = s.get("customKeyEnc").and_then(|v| v.as_str()) {
            if !enc.is_empty() {
                // customKeyEnc was written via Electron's safeStorage.encryptString directly
                // (same Chromium os_crypt scheme as the account "safe:" cookies, just without
                // the tag prefix); reuse the same Local-State-backed reader, not raw DPAPI.
                legacy = crypto::decrypt_electron_safe_storage(enc, &local_state_path());
            }
        }
        if legacy.is_none() {
            if let Some(k) = s.get("customKey").and_then(|v| v.as_str()) {
                if !k.trim().is_empty() {
                    legacy = Some(k.trim().to_string());
                }
            }
        }
        if let Some(pass) = legacy {
            let mut rest = s.clone();
            rest.remove("customKey");
            rest.remove("customKeyEnc");
            rest.insert("keyVerifier".into(), Value::String(make_verifier(&pass)));
            save_settings(&rest);
            *state.session_pass.lock().unwrap() = Some(pass);
        }
    }
}
