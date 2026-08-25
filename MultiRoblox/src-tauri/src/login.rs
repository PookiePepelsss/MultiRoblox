use crate::state::AppState;
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::network::SetCookieParams;
use futures::StreamExt;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use url::Url;

fn system_chrome_paths() -> Vec<PathBuf> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    let pf86 =
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
    let local =
        std::env::var("LOCALAPPDATA").unwrap_or_else(|_| format!(r"{}\AppData\Local", home));
    vec![
        Path::new(&pf)
            .join("Google")
            .join("Chrome")
            .join("Application")
            .join("chrome.exe"),
        Path::new(&pf86)
            .join("Google")
            .join("Chrome")
            .join("Application")
            .join("chrome.exe"),
        Path::new(&local)
            .join("Google")
            .join("Chrome")
            .join("Application")
            .join("chrome.exe"),
        Path::new(&pf86)
            .join("Microsoft")
            .join("Edge")
            .join("Application")
            .join("msedge.exe"),
        Path::new(&pf)
            .join("Microsoft")
            .join("Edge")
            .join("Application")
            .join("msedge.exe"),
        Path::new(&pf)
            .join("BraveSoftware")
            .join("Brave-Browser")
            .join("Application")
            .join("brave.exe"),
        Path::new(&local)
            .join("BraveSoftware")
            .join("Brave-Browser")
            .join("Application")
            .join("brave.exe"),
    ]
}

fn chrome_cache_dir() -> PathBuf {
    crate::paths::app_data_dir().join("chrome-for-login")
}

fn find_cached_chrome() -> Option<PathBuf> {
    let dir = chrome_cache_dir();
    if !dir.exists() {
        return None;
    }
    fn walk(dir: &Path, depth: u32) -> Option<PathBuf> {
        if depth > 4 {
            return None;
        }
        let entries = std::fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.file_name().and_then(|n| n.to_str()) == Some("chrome.exe") {
                return Some(path);
            }
        }
        for entry in std::fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = walk(&path, depth + 1) {
                    return Some(found);
                }
            }
        }
        None
    }
    walk(&dir, 0)
}

async fn download_chrome(app: &AppHandle, state: &AppState) -> Option<PathBuf> {
    let _ = app.emit(
        "chrome:download-progress",
        serde_json::json!({ "status": "downloading", "percent": 0 }),
    );

    let versions_json: Value = state
        .http
        .get("https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let version = versions_json
        .get("channels")?
        .get("Stable")?
        .get("version")?
        .as_str()?
        .to_string();

    let platform = "win64"; // this app is Windows-only
    let url = format!(
        "https://storage.googleapis.com/chrome-for-testing-public/{}/{}/chrome-{}.zip",
        version, platform, platform
    );

    let cache_dir = chrome_cache_dir();
    let _ = std::fs::create_dir_all(&cache_dir);
    let zip_path = cache_dir.join("chrome.zip");

    let mut resp = state.http.get(&url).send().await.ok()?;
    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = tokio::fs::File::create(&zip_path).await.ok()?;
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = resp.chunk().await.ok()? {
        file.write_all(&chunk).await.ok()?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let percent = ((downloaded as f64 / total as f64) * 100.0).round() as i64;
            let _ = app.emit(
                "chrome:download-progress",
                serde_json::json!({ "status": "downloading", "percent": percent }),
            );
        }
    }
    drop(file);

    let zip_path2 = zip_path.clone();
    let cache_dir2 = cache_dir.clone();
    let extracted = tokio::task::spawn_blocking(move || -> Option<PathBuf> {
        let file = std::fs::File::open(&zip_path2).ok()?;
        let mut archive = zip::ZipArchive::new(file).ok()?;
        archive.extract(&cache_dir2).ok()?;
        None::<PathBuf>
    })
    .await
    .ok()?;
    let _ = extracted;
    let _ = std::fs::remove_file(&zip_path);

    let _ = app.emit(
        "chrome:download-progress",
        serde_json::json!({ "status": "done" }),
    );
    find_cached_chrome()
}

async fn ensure_chrome(app: &AppHandle, state: &AppState) -> Option<PathBuf> {
    for p in system_chrome_paths() {
        if p.exists() {
            return Some(p);
        }
    }
    if let Some(p) = find_cached_chrome() {
        return Some(p);
    }
    download_chrome(app, state).await
}

pub struct LoginResult {
    pub success: bool,
    pub cookie: Option<String>,
    pub username: Option<String>,
    pub user_id: Option<String>,
    pub error: Option<String>,
}

// Native Tauri window instead of driving a downloaded Chrome over CDP;
// Chrome 136+ forces the "controlled by automated test software" banner and
// full tabbed UI whenever CDP is attached (--app=<url> gets ignored), so a
// clean chromeless login window isn't possible that way anymore. A
// WebviewWindow has no tabs/address bar by default and reads cookies via
// cookies_for_url() with no CDP needed.
pub async fn open_login(app: &AppHandle, state: &AppState) -> LoginResult {
    let label = format!("login-{}", uuid::Uuid::new_v4().simple());
    let login_url = match Url::parse("https://www.roblox.com/login") {
        Ok(u) => u,
        Err(e) => {
            return LoginResult {
                success: false,
                cookie: None,
                username: None,
                user_id: None,
                error: Some(e.to_string()),
            }
        }
    };

    // incognito: a persistent cookie store here would leak the session
    // across login attempts, silently reusing whichever account was already
    // logged in instead of showing a fresh login page.
    let window = match tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(login_url))
        .title("Log in to Roblox")
        .inner_size(900.0, 720.0)
        .resizable(true)
        .center()
        .incognito(true)
        .build()
    {
        Ok(w) => w,
        Err(e) => {
            return LoginResult {
                success: false,
                cookie: None,
                username: None,
                user_id: None,
                error: Some(format!("Failed to open login window: {}", e)),
            }
        }
    };

    let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let closed2 = closed.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                closed2.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });
    }

    // Cancel any still-running previous attempt first; state.login_cancel
    // is a single slot, so a stray "Use browser" -> Back -> "Use browser"
    // sequence could otherwise clobber a still-live sender.
    if let Some(stale) = state.login_cancel.lock().unwrap().take() {
        let _ = stale.send(());
    }
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    *state.login_cancel.lock().unwrap() = Some(cancel_tx);

    let cookie_url = Url::parse("https://www.roblox.com").unwrap();
    let result = async {
        let started = std::time::Instant::now();
        let timeout = Duration::from_secs(5 * 60);
        loop {
            if started.elapsed() >= timeout {
                return LoginResult { success: false, cookie: None, username: None, user_id: None, error: Some("Timed out waiting for login. Please try again, or use \"Paste Cookie\".".into()) };
            }
            if closed.load(std::sync::atomic::Ordering::SeqCst) {
                return LoginResult { success: false, cookie: None, username: None, user_id: None, error: Some("Login window closed".into()) };
            }
            tokio::select! {
                _ = &mut cancel_rx => {
                    return LoginResult { success: false, cookie: None, username: None, user_id: None, error: Some("Login window closed".into()) };
                }
                _ = tokio::time::sleep(Duration::from_millis(1200)) => {
                    let found = window
                        .cookies_for_url(cookie_url.clone())
                        .ok()
                        .and_then(|cookies| {
                            cookies.into_iter().find(|c| {
                                c.name() == ".ROBLOSECURITY" && c.value().len() > 100
                            })
                        })
                        .map(|c| c.value().to_string());
                    if let Some(cookie_val) = found {
                        let info = crate::roblox_api::fetch_user_info(state, &cookie_val).await;
                        if !info.ok {
                            return LoginResult { success: false, cookie: None, username: None, user_id: None, error: Some(info.reason.unwrap_or_else(|| "Could not verify account.".into())) };
                        }
                        return LoginResult { success: true, cookie: Some(cookie_val), username: info.username, user_id: info.user_id, error: None };
                    }
                }
            }
        }
    }
    .await;

    // Not clearing state.login_cancel here; if a newer open_login call
    // already cancelled and replaced it, doing so would rip out its sender.
    let _ = window.close();
    result
}

pub async fn open_login_with_credentials(
    app: &AppHandle,
    state: &AppState,
    username: &str,
    password: &str,
) -> LoginResult {
    let label = format!("login-{}", uuid::Uuid::new_v4().simple());
    let login_url = match Url::parse("https://www.roblox.com/login") {
        Ok(u) => u,
        Err(e) => return LoginResult { success: false, cookie: None, username: None, user_id: None, error: Some(e.to_string()) },
    };

    let window = match tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(login_url))
        .title("Logging in...")
        .inner_size(900.0, 720.0)
        .resizable(true)
        .center()
        .incognito(true)
        .build()
    {
        Ok(w) => w,
        Err(e) => return LoginResult { success: false, cookie: None, username: None, user_id: None, error: Some(format!("Failed to open login window: {}", e)) },
    };

    let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let closed2 = closed.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                closed2.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });
    }

    if let Some(stale) = state.login_cancel.lock().unwrap().take() {
        let _ = stale.send(());
    }
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    *state.login_cancel.lock().unwrap() = Some(cancel_tx);

    // Escape the credentials for safe JS string embedding.
    let js_username = username.replace('\\', "\\\\").replace('"', "\\\"");
    let js_password = password.replace('\\', "\\\\").replace('"', "\\\"");

    // Wait for the login form to appear then fill and submit it.
    // Roblox's login page is a React SPA; the inputs need React's own
    // synthetic event system to register the value, not just a direct .value=
    // assignment. The nativeInputValueSetter trick below fires the correct
    // React onChange so the submit button becomes enabled.
    let inject_js = format!(r#"
        (function tryFill() {{
            var u = document.getElementById('login-username');
            var p = document.getElementById('login-password');
            if (!u || !p) {{ setTimeout(tryFill, 300); return; }}
            var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(u, "{username}");
            u.dispatchEvent(new Event('input', {{ bubbles: true }}));
            setter.call(p, "{password}");
            p.dispatchEvent(new Event('input', {{ bubbles: true }}));
            setTimeout(function() {{
                var btn = document.getElementById('login-button');
                if (btn) btn.click();
            }}, 300);
        }})();
    "#, username = js_username, password = js_password);

    // Give WebView2 time to paint before injecting.
    tokio::time::sleep(Duration::from_millis(1800)).await;
    let _ = window.eval(&inject_js);

    let cookie_url = Url::parse("https://www.roblox.com").unwrap();
    let result = async {
        let started = std::time::Instant::now();
        let timeout = Duration::from_secs(5 * 60);
        loop {
            if started.elapsed() >= timeout {
                return LoginResult { success: false, cookie: None, username: None, user_id: None, error: Some("Timed out waiting for login.".into()) };
            }
            if closed.load(std::sync::atomic::Ordering::SeqCst) {
                return LoginResult { success: false, cookie: None, username: None, user_id: None, error: Some("Login window closed".into()) };
            }
            tokio::select! {
                _ = &mut cancel_rx => {
                    return LoginResult { success: false, cookie: None, username: None, user_id: None, error: Some("Login window closed".into()) };
                }
                _ = tokio::time::sleep(Duration::from_millis(1200)) => {
                    let found = window
                        .cookies_for_url(cookie_url.clone())
                        .ok()
                        .and_then(|cookies| {
                            cookies.into_iter().find(|c| {
                                c.name() == ".ROBLOSECURITY" && c.value().len() > 100
                            })
                        })
                        .map(|c| c.value().to_string());
                    if let Some(cookie_val) = found {
                        let info = crate::roblox_api::fetch_user_info(state, &cookie_val).await;
                        if !info.ok {
                            return LoginResult { success: false, cookie: None, username: None, user_id: None, error: Some(info.reason.unwrap_or_else(|| "Could not verify account.".into())) };
                        }
                        return LoginResult { success: true, cookie: Some(cookie_val), username: info.username, user_id: info.user_id, error: None };
                    }
                }
            }
        }
    }
    .await;

    let _ = window.close();
    result
}

pub fn cancel_login(state: &AppState) {
    if let Some(tx) = state.login_cancel.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

// Cleans up mr-login-* temp profile dirs left behind by older builds.
pub fn sweep_stale_login_profiles() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(6 * 60 * 60);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("mr-login-") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.modified().map(|t| t < cutoff).unwrap_or(false) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

// "Open in browser": launches a real Chrome window with the account's
// cookie pre-seeded, and leaves it open for the user.
pub async fn open_account_in_browser(
    app: &AppHandle,
    state: &AppState,
    cookie: &str,
) -> Result<(), String> {
    let chrome_path = ensure_chrome(app, state)
        .await
        .ok_or_else(|| "Failed to find or download Chrome".to_string())?;

    let config = BrowserConfig::builder()
        .chrome_executable(&chrome_path)
        .with_head()
        .args(vec!["--disable-blink-features=AutomationControlled"])
        .build()
        .map_err(|e| format!("Failed to launch Chrome: {}", e))?;

    let (browser, mut handler) = Browser::launch(config)
        .await
        .map_err(|e| format!("Failed to launch Chrome: {}", e))?;
    tokio::spawn(async move { while handler.next().await.is_some() {} });

    let page = browser
        .new_page("about:blank")
        .await
        .map_err(|e| e.to_string())?;
    let cookie_params = SetCookieParams::builder()
        .name(".ROBLOSECURITY")
        .value(cookie)
        .domain(".roblox.com")
        .url("https://www.roblox.com")
        .http_only(true)
        .secure(true)
        .build()
        .map_err(|e| e.to_string())?;
    page.execute(cookie_params)
        .await
        .map_err(|e| e.to_string())?;
    page.goto("https://www.roblox.com/home")
        .await
        .map_err(|e| e.to_string())?;

    std::mem::forget(browser);
    Ok(())
}
