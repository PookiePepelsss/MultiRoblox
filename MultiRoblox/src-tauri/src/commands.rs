use crate::encryption;
use crate::settings::{load_settings, save_settings};
use crate::state::AppState;
use crate::storage;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
    }
}

// ---- settings ----
#[tauri::command]
pub fn settings_load() -> Value {
    let mut s = load_settings();
    for k in ["customKeyEnc", "customKey", "keyVerifier", "_deviceKey"] {
        s.remove(k);
    }
    let key_set = encryption::passphrase_mode();
    s.insert("keySet".into(), Value::Bool(key_set));
    Value::Object(s)
}

#[tauri::command]
pub fn settings_save(state: State<AppState>, data: Map<String, Value>) -> bool {
    let mut data = data;
    for k in ["customKey", "customKeyEnc", "keyVerifier"] {
        data.remove(k);
    }
    let mut s = load_settings();
    s.remove("webhook");
    s.remove("screenshotsEnabled");
    let multi_instance = data.get("multiInstance").cloned();
    let antiafk = data.get("antiAfk").cloned();
    let antiafk_interval_changed = data.contains_key("antiAfkInterval");
    for (k, v) in data {
        s.insert(k, v);
    }
    save_settings(&s);
    if let Some(Value::Bool(on)) = multi_instance {
        // Releases/re-acquires the mutex inside the one helper process --
        // toggling this no longer starts or kills anything.
        let app = state.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let st = app.state::<AppState>();
            crate::native::set_multi_instance(&app, &st, on).await;
        });
    }
    if let Some(Value::Bool(on)) = antiafk {
        let app = state.app_handle.clone();
        if on {
            tauri::async_runtime::spawn(async move {
                let st = app.state::<AppState>();
                crate::native::start_antiafk(&app, &st).await;
            });
        } else {
            crate::native::stop_antiafk(&state);
        }
    } else if antiafk_interval_changed
        && state.antiafk_on.load(std::sync::atomic::Ordering::SeqCst)
    {
        // Re-arm at the new interval. start_antiafk replaces the helper's
        // existing anti-AFK thread, so no explicit stop is needed first.
        let app = state.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let st = app.state::<AppState>();
            crate::native::start_antiafk(&app, &st).await;
        });
    }
    true
}

// ---- encryption ----
#[tauri::command]
pub fn enc_status(state: State<AppState>) -> Value {
    if !encryption::passphrase_mode() {
        return serde_json::json!({ "mode": "setup" });
    }
    let unlocked = state.session_pass.lock().unwrap().is_some();
    serde_json::json!({ "mode": if unlocked { "unlocked" } else { "locked" } })
}

#[tauri::command]
pub fn enc_unlock(state: State<AppState>, pass: String) -> Value {
    if pass.is_empty() || !encryption::verify_pass(&pass) {
        return serde_json::json!({ "ok": false });
    }
    *state.session_pass.lock().unwrap() = Some(pass);
    encryption::invalidate_key_cache(&state);
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn enc_set_key(state: State<AppState>, pass: Option<String>) -> Value {
    let np = pass.unwrap_or_default().trim().to_string();
    let raw = storage::load_accounts_raw();
    let accts_dec: Vec<Value> = raw
        .iter()
        .cloned()
        .map(|a| storage::decrypt_account(&state, a))
        .collect();
    for (orig, dec) in raw.iter().zip(accts_dec.iter()) {
        let had_cookie = orig
            .get("cookie")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let now_empty = dec
            .get("cookie")
            .and_then(|v| v.as_str())
            .map(|s| s.is_empty())
            .unwrap_or(true);
        if had_cookie && now_empty {
            return serde_json::json!({ "ok": false, "error": "decrypt failed" });
        }
    }

    if !np.is_empty() {
        encryption::rotate_salt();
        *state.session_pass.lock().unwrap() = Some(np.clone());
        encryption::invalidate_key_cache(&state);
        let mut rest = load_settings();
        rest.remove("customKey");
        rest.remove("customKeyEnc");
        let verifier = encryption::make_verifier(&np);
        rest.insert("keyVerifier".into(), Value::String(verifier));
        rest.insert("encSetupDone".into(), Value::Bool(true));
        save_settings(&rest);
    } else {
        *state.session_pass.lock().unwrap() = None;
        encryption::invalidate_key_cache(&state);
        let mut rest = load_settings();
        rest.remove("customKey");
        rest.remove("customKeyEnc");
        rest.remove("keyVerifier");
        rest.insert("encSetupDone".into(), Value::Bool(true));
        save_settings(&rest);
    }
    encryption::invalidate_key_cache(&state);
    match storage::save_accounts(&state, accts_dec) {
        Ok(_) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub async fn multiinstance_status(state: State<'_, AppState>) -> Result<Value, ()> {
    // Defaults on, matching the startup path in lib.rs -- only an explicit
    // false counts as off. These two used to disagree (false here, true
    // there), so on a fresh install the toggle read "off" while the helper was
    // already holding the mutex.
    let enabled = load_settings()
        .get("multiInstance")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    // "active" now means the one helper is up AND actually holding the mutex,
    // which is a stronger (and more honest) signal than "a child exists".
    let active = crate::helper::is_holding_mutex(&state).await;
    Ok(serde_json::json!({ "enabled": enabled, "active": active }))
}

#[tauri::command]
pub fn antiafk_status(state: State<AppState>) -> Value {
    let enabled = load_settings()
        .get("antiAfk")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let active = state.antiafk_on.load(std::sync::atomic::Ordering::SeqCst);
    serde_json::json!({ "enabled": enabled, "active": active })
}

// ---- accounts ----
#[tauri::command]
pub fn accounts_load(state: State<AppState>) -> Vec<Value> {
    storage::load_accounts(&state)
}

#[tauri::command]
pub fn accounts_add(state: State<AppState>, account: Map<String, Value>) -> Result<Value, String> {
    let mut accounts = storage::load_accounts(&state);
    let mut a = Value::Object(account);
    a["id"] = Value::String(uuid::Uuid::new_v4().to_string());
    a["createdAt"] = Value::String(chrono::Utc::now().to_rfc3339());
    a["lastUsed"] = Value::Null;
    accounts.push(a.clone());
    storage::save_accounts(&state, accounts)?;
    Ok(a)
}

#[tauri::command]
pub fn accounts_remove(state: State<AppState>, id: String) -> Result<bool, String> {
    let accounts = storage::load_accounts(&state);
    let filtered: Vec<Value> = accounts
        .into_iter()
        .filter(|a| a.get("id").and_then(|v| v.as_str()) != Some(id.as_str()))
        .collect();
    storage::save_accounts(&state, filtered)?;
    // Drop bookkeeping so watch_tick stops polling a removed account.
    state.account_pids.lock().unwrap().remove(&id);
    state.watched_accounts.lock().unwrap().remove(&id);
    state.miss_counts.lock().unwrap().remove(&id);
    state.auto_relaunch_history.lock().unwrap().remove(&id);
    Ok(true)
}

#[tauri::command]
pub fn accounts_update(
    state: State<AppState>,
    id: String,
    data: Map<String, Value>,
) -> Result<Option<Value>, String> {
    let mut accounts = storage::load_accounts(&state);
    let idx = accounts
        .iter()
        .position(|a| a.get("id").and_then(|v| v.as_str()) == Some(id.as_str()));
    match idx {
        Some(i) => {
            if let Value::Object(existing) = &mut accounts[i] {
                for (k, v) in data {
                    existing.insert(k, v);
                }
            }
            let updated = accounts[i].clone();
            storage::save_accounts(&state, accounts)?;
            Ok(Some(updated))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn accounts_reorder(state: State<AppState>, ids: Vec<String>) -> Result<bool, String> {
    let accounts = storage::load_accounts(&state);
    let mut reordered: Vec<Value> = Vec::new();
    for id in &ids {
        if let Some(a) = accounts
            .iter()
            .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        {
            reordered.push(a.clone());
        }
    }
    let rest: Vec<Value> = accounts
        .into_iter()
        .filter(|a| {
            let aid = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
            !ids.iter().any(|id| id == aid)
        })
        .collect();
    reordered.extend(rest);
    storage::save_accounts(&state, reordered)?;
    Ok(true)
}

// ---- packages ----
#[tauri::command]
pub fn packages_load() -> Vec<Value> {
    storage::load_packages()
}
#[tauri::command]
pub fn packages_save(packages: Vec<Value>) -> bool {
    storage::save_packages(&packages).is_ok()
}

// ---- generated-account history ----
#[tauri::command]
pub fn genhistory_read(state: State<AppState>) -> Vec<Value> {
    storage::read_genhistory(&state)
}
#[tauri::command]
pub fn genhistory_write(state: State<AppState>, list: Vec<Value>) -> bool {
    storage::write_genhistory(&state, list).is_ok()
}
#[tauri::command]
pub fn genhistory_clear() -> bool {
    storage::write_json_array(&crate::paths::genhistory_path(), &[]).is_ok()
}

// ---- fflags / fps ----
#[tauri::command]
pub fn fflag_read() -> Value {
    match crate::native::get_fflag_path() {
        Some(p) if p.exists() => std::fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| Value::Object(Map::new())),
        _ => Value::Object(Map::new()),
    }
}

#[tauri::command]
pub fn fflag_write(flags: Value) -> bool {
    let Some(p) = crate::native::get_fflag_path() else {
        return false;
    };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(
        &p,
        serde_json::to_string_pretty(&flags).unwrap_or_else(|_| "{}".into()),
    )
    .is_ok()
}

// Compiled once instead of on every read/write. The patterns are constants,
// so Regex::new can't fail on them -- doing it per call just re-paid the
// compile and kept an unwrap in the path for no reason.
static FPS_CAP_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(r#"(?i)<int\s+name="FramerateCap"\s*>(\d+)</int>"#).unwrap()
});
static FPS_CAP_REPLACE_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(r#"(?i)<int\s+name="FramerateCap"\s*>\d+</int>"#).unwrap()
});
static CLOSING_ITEM_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"</Item>").unwrap());

fn global_settings_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    std::path::PathBuf::from(home)
        .join("AppData")
        .join("Local")
        .join("Roblox")
        .join("GlobalBasicSettings_13.xml")
}

#[tauri::command]
pub fn fps_read() -> i64 {
    let p = global_settings_path();
    let Ok(xml) = std::fs::read_to_string(&p) else {
        return 60;
    };
    FPS_CAP_RE
        .captures(&xml)
        .and_then(|c| c[1].parse::<i64>().ok())
        .unwrap_or(60)
}

#[tauri::command]
pub fn fps_write(cap: f64) -> Value {
    let p = global_settings_path();
    let Ok(xml) = std::fs::read_to_string(&p) else {
        return serde_json::json!({ "ok": false, "error": "GlobalBasicSettings_13.xml not found - launch Roblox once to create it." });
    };
    let raw = cap.round().max(0.0) as i64;
    let value = if raw == 0 { 9999 } else { raw };
    let new_xml = if FPS_CAP_REPLACE_RE.is_match(&xml) {
        FPS_CAP_REPLACE_RE
            .replace(&xml, format!(r#"<int name="FramerateCap">{}</int>"#, value))
            .to_string()
    } else {
        CLOSING_ITEM_RE.replace(
            &xml,
            format!("\t\t<int name=\"FramerateCap\">{}</int>\n</Item>", value),
        )
        .to_string()
    };
    // Some bootstrappers mark this file read-only for their own FPS
    // unlocker -- clear it so our write isn't silently blocked.
    if let Ok(meta) = std::fs::metadata(&p) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(&p, perms);
        }
    }
    if std::fs::write(&p, new_xml).is_err() {
        return serde_json::json!({ "ok": false, "error": "Failed to write GlobalBasicSettings_13.xml (file may be locked by another app)" });
    }
    serde_json::json!({ "ok": true })
}

// ---- roblox process / launch ----
#[tauri::command]
pub async fn roblox_get_version(
    app: AppHandle,
    state: State<'_, AppState>,
    channel: Option<String>,
) -> Result<Option<String>, ()> {
    // One retry -- covers a transient blip (CDN hiccup, brief DNS failure)
    // instead of leaving the badge stuck on "Not detected" until next launch.
    match crate::roblox_api::get_roblox_version(&state, channel.as_deref()).await {
        Ok(v) => Ok(Some(v)),
        Err(_) => {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            match crate::roblox_api::get_roblox_version(&state, channel.as_deref()).await {
                Ok(v) => Ok(Some(v)),
                Err(e) => {
                    crate::native::emit_log(&app, "warn", "system", &format!("Could not fetch latest Roblox version: {e}"), None);
                    Ok(None)
                }
            }
        }
    }
}

#[tauri::command]
pub async fn roblox_validate_cookie(
    state: State<'_, AppState>,
    cookie: String,
) -> Result<Value, ()> {
    let info = crate::roblox_api::fetch_user_info(&state, &cookie).await;
    Ok(
        serde_json::json!({ "ok": info.ok, "username": info.username, "userId": info.user_id, "reason": info.reason }),
    )
}

#[tauri::command]
pub async fn roblox_set_volume(
    app: AppHandle,
    state: State<'_, AppState>,
    percent: f64,
) -> Result<Value, ()> {
    Ok(crate::native::set_roblox_volume(&app, &state, percent).await)
}

#[tauri::command]
pub async fn roblox_kill_all(app: AppHandle, state: State<'_, AppState>) -> Result<Value, ()> {
    let accounts = storage::load_accounts(&state);
    let running_names: Vec<String> = state
        .watched_accounts
        .lock()
        .unwrap()
        .keys()
        .map(|id| {
            accounts
                .iter()
                .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                .and_then(|a| a.get("username"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| id.clone())
        })
        .collect();
    let count = state.watched_accounts.lock().unwrap().len();
    crate::native::emit_log(
        &app,
        "warn",
        "kill",
        &format!(
            "Killing Roblox instances launched by MultiRoblox ({} running: {})",
            count,
            if running_names.is_empty() {
                "none".into()
            } else {
                running_names.join(", ")
            }
        ),
        Some(serde_json::json!({ "count": count, "accounts": running_names })),
    );
    Ok(crate::native::kill_all_roblox(&app, &state).await)
}

#[tauri::command]
pub async fn roblox_kill_one(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Value, ()> {
    let accounts = storage::load_accounts(&state);
    let acct = accounts
        .iter()
        .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        .cloned()
        .unwrap_or(Value::Null);
    let username = acct
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let user_id = acct.get("userId").and_then(|v| v.as_str());
    let pid = state.account_pids.lock().unwrap().get(&id).copied();
    crate::native::emit_log(
        &app,
        "warn",
        "kill",
        &format!("Killed Roblox instance for {}", username),
        Some(
            serde_json::json!({ "accountId": id, "username": username, "userId": user_id, "pid": pid }),
        ),
    );
    Ok(crate::native::kill_account_roblox(&app, &state, &id).await)
}

#[tauri::command]
pub async fn roblox_running_count(app: AppHandle, state: State<'_, AppState>) -> Result<u32, ()> {
    Ok(crate::native::count_roblox_processes(&app, &state).await)
}

// Polled by the frontend to self-heal card state if a push event is missed.
#[tauri::command]
pub async fn roblox_watched_ids(state: State<'_, AppState>) -> Result<Vec<String>, ()> {
    Ok(state
        .watched_accounts
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect())
}

#[tauri::command]
pub async fn roblox_trim_memory(app: AppHandle, state: State<'_, AppState>) -> Result<Value, ()> {
    Ok(crate::native::trim_roblox_memory(&app, &state).await)
}

#[tauri::command]
pub async fn roblox_trim_account_memory(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Value, ()> {
    Ok(crate::native::trim_account_memory(&app, &state, &id).await)
}

#[tauri::command]
pub fn roblox_set_account_priority(state: State<AppState>, id: String, priority: String) -> Value {
    crate::native::set_account_priority(&state, &id, &priority)
}

#[tauri::command]
pub async fn roblox_get_game_name(
    state: State<'_, AppState>,
    place_id_or_target: String,
    cookie: String,
) -> Result<Option<String>, ()> {
    Ok(crate::roblox_api::get_game_name(&state, &place_id_or_target, &cookie).await)
}

#[tauri::command]
pub async fn roblox_get_json(state: State<'_, AppState>, url: String) -> Result<Value, String> {
    crate::roblox_api::get_json_public(&state, &url).await
}

// Presence check for the blue ("in the app") vs green ("in a game") account
// card distinction. One request covers every currently-launched account --
// any one of their cookies can query presence for the whole batch, Roblox
// doesn't require the querying account to be in the list.
#[tauri::command]
pub async fn roblox_in_game_ids(
    state: State<'_, AppState>,
    cookie: String,
    user_ids: Vec<i64>,
) -> Result<Vec<i64>, String> {
    crate::roblox_api::get_in_game_user_ids(&state, &cookie, &user_ids).await
}

#[tauri::command]
pub async fn altgen_generate(
    state: State<'_, AppState>,
    api_key: String,
    quantity: i64,
) -> Result<Value, String> {
    crate::roblox_api::altgen_generate(&state, &api_key, quantity).await
}

#[tauri::command]
pub async fn roblox_launch(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cookie: String,
    target: Option<String>,
) -> Result<Value, ()> {
    // Registered before queueing on launch_lock so a launch still waiting its
    // turn behind another one can be cancelled as well.
    let cancel = crate::native::register_launch(&state, &id);
    let _guard = state.launch_lock.lock().await;
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        crate::native::finish_launch(&state, &id);
        return Ok(serde_json::json!({ "success": false, "cancelled": true, "error": "Launch cancelled" }));
    }
    let result =
        crate::native::do_launch(&app, &state, &id, &cookie, target.as_deref().unwrap_or("")).await;
    crate::native::finish_launch(&state, &id);
    Ok(result)
}

#[tauri::command]
pub fn roblox_launch_cancel(state: State<AppState>, id: String) -> Value {
    serde_json::json!({ "ok": crate::native::cancel_launch(&state, &id) })
}

// ---- browser login ----
#[tauri::command]
pub async fn roblox_open_login(app: AppHandle, state: State<'_, AppState>) -> Result<Value, ()> {
    let r = crate::login::open_login(&app, &state).await;
    Ok(
        serde_json::json!({ "success": r.success, "cookie": r.cookie, "username": r.username, "userId": r.user_id, "error": r.error }),
    )
}

#[tauri::command]
pub fn login_cancel(state: State<AppState>) {
    crate::login::cancel_login(&state);
}

#[tauri::command]
pub async fn roblox_open_account_browser(
    app: AppHandle,
    state: State<'_, AppState>,
    cookie: String,
) -> Result<Value, ()> {
    match crate::login::open_account_in_browser(&app, &state, &cookie).await {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

// ---- tracking (screenshots -> Discord webhook) ----
#[tauri::command]
pub async fn tracking_capture_preview(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Value, ()> {
    match crate::tracking::capture_preview_b64(&app, &state, &id).await {
        Ok(b64) => Ok(serde_json::json!({ "ok": true, "dataUrl": format!("data:image/png;base64,{}", b64) })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

// Lets the UI reject a bad URL as it's typed instead of silently failing on
// the next capture. The backend check in capture_and_send is the real gate.
#[tauri::command]
pub fn tracking_validate_webhook(url: String) -> Value {
    match crate::tracking::validate_webhook_url(&url) {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

fn parse_region(region: &Value) -> Option<(f64, f64, f64, f64)> {
    Some((region.get("x")?.as_f64()?, region.get("y")?.as_f64()?, region.get("w")?.as_f64()?, region.get("h")?.as_f64()?))
}

#[tauri::command]
pub async fn tracking_capture_and_send(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    username: String,
    webhook_url: String,
    regions: Option<Vec<Value>>,
) -> Result<Value, ()> {
    let crops: Vec<(f64, f64, f64, f64)> = regions.unwrap_or_default().iter().filter_map(parse_region).collect();
    match crate::tracking::capture_and_send(&app, &state, &id, &username, &webhook_url, crops).await {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

// Full reset from the lock screen -- stops the helper first and waits for it
// to actually exit (it holds its own exe file open, which would otherwise
// make deleting the folder fail on Windows), wipes the entire app-data
// folder, then clears the in-memory state that would otherwise still point
// at it. The frontend only reloads the webview afterwards, not the Rust
// process, so the helper has to be brought back up here.
#[tauri::command]
pub async fn clear_app_data(app: AppHandle, state: State<'_, AppState>) -> Result<Value, ()> {
    crate::native::stop_all_native_helpers(&state).await;
    let dir = crate::paths::app_data_dir();
    let result = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&dir)).await;
    crate::native::reset_state_for_wipe(&state);
    // Re-extracts the embedded helper into the now-empty folder and starts
    // exactly one again, holding the mutex as before.
    crate::native::start_mutex_holder(&app, &state).await;
    match result {
        Ok(Ok(())) => Ok(serde_json::json!({ "ok": true })),
        Ok(Err(e)) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

// ---- misc ----
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
