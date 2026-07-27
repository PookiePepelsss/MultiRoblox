// The single resident RobloxNative.exe for the whole app session.
//
// Previously every concern spawned its own helper process: `mutex` and
// `antiafk` were resident, `watch` came and went with the watch loop, and
// `closehandles`/`volume`/`pids`/`capture` were spawned one-shot -- the first
// two on EVERY launch. That meant a variable number of RobloxNative.exe
// processes, several of them short-lived, and any of them could outlive the
// app if a kill signal raced app exit (kill() only signals; it doesn't wait).
//
// Now there is exactly one. It starts with MultiRoblox, holds the singleton
// mutexes for the whole session, runs anti-AFK and the PID watcher on its own
// background threads, and answers everything else as a request over a pipe.
// It dies with MultiRoblox: explicitly on clean exit, and otherwise because
// closing our end of its stdin gives it EOF -- which covers a crash or a
// Task Manager kill, where no shutdown code of ours would ever run.
use crate::state::AppState;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
/// Captures focus/restore a window and PNG-encode, so they need more headroom
/// than a plain request -- matches the old one-shot capture timeout.
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(25);
/// The handle-table scan can genuinely take seconds with many processes open.
pub const SLOW_TIMEOUT: Duration = Duration::from_secs(30);

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<String, String>>>>>;

/// Backoff after a spawn that failed for any reason other than "someone else
/// already has one" -- stops a broken helper (missing .NET, AV quarantine)
/// from being re-spawned on every status poll.
const SPAWN_RETRY_BACKOFF_MS: i64 = 10_000;

/// True when a helper owned by someone else (another MultiRoblox instance) is
/// already running. Checked before spawning, because the daemon's own
/// singleton guard can only reject a duplicate *after* it has been started --
/// and the frontend polls status every 3s, so "spawn, get rejected, exit"
/// would otherwise repeat forever. Opening the name is cheap and creates
/// nothing, so this never disturbs the incumbent.
#[cfg(windows)]
fn another_helper_running() -> bool {
    use windows::core::w;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_ACCESS_RIGHTS};
    const SYNCHRONIZE_ACCESS: SYNCHRONIZATION_ACCESS_RIGHTS =
        SYNCHRONIZATION_ACCESS_RIGHTS(0x0010_0000);
    unsafe {
        // Name must stay in sync with SINGLETON_NAME in RobloxNative.cs.
        match OpenMutexW(SYNCHRONIZE_ACCESS, false, w!("MultiRoblox_NativeHelper_v1")) {
            Ok(h) => {
                let _ = CloseHandle(h);
                true
            }
            Err(_) => false,
        }
    }
}

#[cfg(not(windows))]
fn another_helper_running() -> bool {
    false
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub struct Helper {
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    /// Whether the daemon reported holding the singleton mutex at startup.
    pub mutex_held: Arc<AtomicBool>,
}

impl Helper {
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Sends one request and awaits its tagged reply. Concurrent callers are
    /// fine: only the write is serialized, and replies are matched by id, so
    /// a slow capture never blocks a pids poll queued behind it.
    pub async fn request(&self, cmd: &str, timeout: Duration) -> Result<String, String> {
        if !self.alive() {
            return Err("native helper is not running".to_string());
        }
        // id 0 is reserved for the unsolicited shutdown line.
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let line = format!("{}|{}\n", id, cmd);
        {
            let mut w = self.stdin.lock().await;
            if w.write_all(line.as_bytes()).await.is_err() || w.flush().await.is_err() {
                self.pending.lock().unwrap().remove(&id);
                self.alive.store(false, Ordering::SeqCst);
                return Err("native helper pipe closed".to_string());
            }
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("native helper stopped responding".to_string()),
            Err(_) => {
                // Drop the slot so a late reply doesn't leak the entry.
                self.pending.lock().unwrap().remove(&id);
                Err("native helper timed out".to_string())
            }
        }
    }
}

/// Returns the live helper, starting it if this is the first call (or if a
/// previous one died). The async mutex is held across the whole spawn so two
/// racing callers can't both get past the liveness check and start a second
/// process -- which is the whole point of this module.
///
/// Boxed rather than a plain `async fn` to break the type recursion: the
/// spawned reader task calls back into `ensure` to restart a dead daemon, and
/// a directly-recursive async fn has an infinitely-nested future type the
/// compiler can't prove `Send` for. Type-erasing here cuts the cycle.
pub fn ensure<'a>(
    app: &'a AppHandle,
    state: &'a AppState,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Arc<Helper>>> + Send + 'a>> {
    Box::pin(async move {
        if !cfg!(windows) {
            return None;
        }
        if state.helper_shutdown.load(Ordering::SeqCst) {
            return None;
        }
        let mut guard = state.helper.lock().await;
        if let Some(h) = guard.as_ref() {
            if h.alive() {
                return Some(h.clone());
            }
        }
        // Sweep first, and only then ask whether a helper is already running:
        // a stray from a crashed session holds the singleton name too, and
        // checking before sweeping would treat our own leftovers as a live
        // owner and refuse to ever start. Sweeping also has to precede the
        // extraction below -- a running stray holds that exe file open, so
        // the write would fail and leave an outdated helper on disk.
        if !state.helper_swept.swap(true, Ordering::SeqCst) {
            sweep_stray_helpers().await;
        }
        // Don't start one we know will be rejected. Callers degrade cleanly
        // (pids falls back to tasklist, the rest surface an error), and the
        // moment the other instance closes, the next poll picks the helper
        // back up -- no restart of this app needed.
        if another_helper_running() {
            return None;
        }
        if now_ms() < *state.helper_next_attempt.lock().unwrap() {
            return None;
        }
        let exe = crate::native::ensure_native_helper(app, state).await?;
        let helper = spawn(app, state, &exe).await?;
        *guard = Some(helper.clone());
        Some(helper)
    })
}

/// Bounds automatic restarts so no failure mode can turn into a respawn
/// storm -- the same shape as the launcher's own auto-relaunch throttle.
const RESTART_MAX: usize = 5;
const RESTART_WINDOW_MS: i64 = 5 * 60 * 1000;

fn restart_allowed(state: &AppState) -> bool {
    let now = chrono::Utc::now().timestamp_millis();
    let mut hist = state.helper_restarts.lock().unwrap();
    hist.retain(|t| now - *t < RESTART_WINDOW_MS);
    if hist.len() >= RESTART_MAX {
        return false;
    }
    hist.push(now);
    true
}

/// Best-effort request against the helper, starting it on demand. Returns the
/// reply payload, or an error string suitable for surfacing in the UI.
pub async fn call(
    app: &AppHandle,
    state: &AppState,
    cmd: &str,
    timeout: Duration,
) -> Result<String, String> {
    let helper = ensure(app, state)
        .await
        .ok_or_else(|| "native helper unavailable".to_string())?;
    helper.request(cmd, timeout).await
}

async fn spawn(app: &AppHandle, state: &AppState, exe: &Path) -> Option<Arc<Helper>> {
    let mut cmd = Command::new(exe);
    cmd.arg("daemon")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::native::hide_window(&mut cmd);
    // Last-resort backstop: if this Child handle is ever dropped without an
    // explicit kill, take the daemon down with it rather than orphan it.
    cmd.kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[helper] spawn failed: {}", e);
            return None;
        }
    };

    let stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take();

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let mutex_held = Arc::new(AtomicBool::new(false));
    // Set when the daemon reports another helper already owns the singleton
    // name and bows out. Restarting on that would fight whoever holds it.
    let duplicate = Arc::new(AtomicBool::new(false));

    let helper = Arc::new(Helper {
        stdin: tokio::sync::Mutex::new(stdin),
        pending: pending.clone(),
        next_id: AtomicU64::new(1),
        alive: alive.clone(),
        mutex_held: mutex_held.clone(),
    });

    *state.helper_child.lock().unwrap() = Some(child);

    let (ready_tx, ready_rx) = oneshot::channel::<bool>();
    let mut ready_tx = Some(ready_tx);

    // Reader: demultiplexes replies and pushes events until the pipe closes.
    let app_r = app.clone();
    let duplicate_r = duplicate.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let line = line.trim_end();
                    if let Some(rest) = line.strip_prefix("R|") {
                        // R|<id>|OK|<payload> -- payload may contain anything
                        // except a newline, so only split off the first three.
                        let mut it = rest.splitn(3, '|');
                        let id = it.next().and_then(|s| s.parse::<u64>().ok());
                        let status = it.next().unwrap_or("");
                        let payload = it.next().unwrap_or("");
                        if let Some(id) = id {
                            let slot = pending.lock().unwrap().remove(&id);
                            if let Some(tx) = slot {
                                let _ = tx.send(if status == "OK" {
                                    Ok(payload.to_string())
                                } else {
                                    Err(payload.to_string())
                                });
                            }
                        }
                    } else if let Some(rest) = line.strip_prefix("E|") {
                        let mut it = rest.splitn(2, '|');
                        let name = it.next().unwrap_or("");
                        let payload = it.next().unwrap_or("");
                        match name {
                            "READY" => {
                                mutex_held.store(payload == "1", Ordering::SeqCst);
                                if let Some(tx) = ready_tx.take() {
                                    let _ = tx.send(payload == "1");
                                }
                            }
                            "PIDS" => {
                                let set: std::collections::HashSet<u32> = payload
                                    .split(',')
                                    .filter_map(|s| s.trim().parse::<u32>().ok())
                                    .collect();
                                let st = app_r.state::<AppState>();
                                *st.watch_pid_cache.lock().unwrap() = Some(set);
                            }
                            "DUPLICATE" => {
                                duplicate_r.store(true, Ordering::SeqCst);
                            }
                            "AFK" => {
                                crate::native::emit_log(
                                    &app_r,
                                    "info",
                                    "afk",
                                    "Anti-AFK: tapped a Roblox window",
                                    Some(serde_json::json!({ "pid": payload.parse::<u32>().ok() })),
                                );
                            }
                            _ => {}
                        }
                    }
                }
                _ => break, // EOF or read error: the daemon is gone
            }
        }

        alive.store(false, Ordering::SeqCst);
        // Nothing will ever answer these now -- release every waiter instead
        // of letting them sit until their individual timeouts.
        let drained: Vec<_> = pending.lock().unwrap().drain().map(|(_, tx)| tx).collect();
        for tx in drained {
            let _ = tx.send(Err("native helper exited".to_string()));
        }
        if let Some(tx) = ready_tx.take() {
            let _ = tx.send(false);
        }

        let st = app_r.state::<AppState>();
        *st.watch_pid_cache.lock().unwrap() = None;
        if st.helper_shutdown.load(Ordering::SeqCst) {
            return; // we asked it to stop
        }

        // It bowed out because another helper owns the singleton name -- most
        // likely a second copy of MultiRoblox is open and swept us. Respawning
        // would just lose the same race again, so stop and say so plainly.
        if duplicate_r.load(Ordering::SeqCst) {
            eprintln!("[helper] another helper already owns the singleton; not restarting");
            crate::native::emit_log(
                &app_r,
                "warn",
                "system",
                "Another MultiRoblox instance owns the native helper - close it and restart this one",
                None,
            );
            return;
        }

        // Any other failure mode: don't retry without limit. A helper that
        // dies instantly on every start (mismatched build, AV quarantine,
        // missing .NET) would otherwise spawn processes forever.
        if !restart_allowed(&st) {
            eprintln!("[helper] too many restarts; giving up");
            crate::native::emit_log(
                &app_r,
                "err",
                "system",
                "Native helper keeps stopping - giving up. Restart MultiRoblox to try again.",
                None,
            );
            return;
        }

        // Unexpected death (helper crashed, or was killed externally). Nobody
        // is holding Roblox's mutex now, so bring a replacement up rather than
        // silently degrading to single-instance until the next app restart.
        eprintln!("[helper] daemon exited unexpectedly; restarting");
        crate::native::emit_log(
            &app_r,
            "warn",
            "system",
            "Native helper stopped unexpectedly - restarting it",
            None,
        );
        {
            let mut g = st.helper.lock().await;
            if g.as_ref().map(|h| !h.alive()).unwrap_or(false) {
                *g = None;
            }
        }
        if let Some(mut c) = st.helper_child.lock().unwrap().take() {
            let _ = c.start_kill();
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Some(h) = ensure(&app_r, &st).await {
            reapply_state(&app_r, &st, &h).await;
        }
    });

    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    eprintln!("[helper] {}", line.trim());
                }
            }
        });
    }

    // The daemon signals READY only after it owns ROBLOX_singletonMutex, so
    // waiting here preserves the old "mutex is held before any launch"
    // guarantee that start_mutex_holder's MUTEX_HELD handshake provided.
    match tokio::time::timeout(Duration::from_secs(10), ready_rx).await {
        Ok(Ok(true)) => {}
        _ => eprintln!("[helper] daemon did not report holding the mutex in time"),
    }

    // Lost a race with another instance that started between our pre-check and
    // this spawn: it already exited on its own. Report failure rather than
    // hand back a dead handle, and don't immediately try again.
    if duplicate.load(Ordering::SeqCst) || !helper.alive() {
        *state.helper_next_attempt.lock().unwrap() = now_ms() + SPAWN_RETRY_BACKOFF_MS;
        if let Some(mut c) = state.helper_child.lock().unwrap().take() {
            let _ = c.start_kill();
        }
        return None;
    }
    *state.helper_next_attempt.lock().unwrap() = 0;

    Some(helper)
}

/// Re-arms whatever the daemon was doing before it died. The mutex is
/// re-acquired by the new daemon on its own at startup; anti-AFK and the PID
/// watcher live in its memory, so they have to be told again.
async fn reapply_state(app: &AppHandle, state: &AppState, helper: &Arc<Helper>) {
    let settings = crate::settings::load_settings();
    if settings
        .get("antiAfk")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        let mut deadline = settings
            .get("antiAfkInterval")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if deadline < 60 {
            deadline = 19 * 60;
        }
        let _ = helper
            .request(&format!("antiafk|{}|0", deadline), DEFAULT_TIMEOUT)
            .await;
    }
    if !state.watched_accounts.lock().unwrap().is_empty() {
        let _ = helper
            .request(
                &format!("watch|{}", crate::native::POLL_INTERVAL.as_millis()),
                DEFAULT_TIMEOUT,
            )
            .await;
    }
    let _ = app;
}

/// Kills helper processes left over from a previous session. Only ever our
/// own executable name, and only before we start ours.
async fn sweep_stray_helpers() {
    if !cfg!(windows) {
        return;
    }
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "taskkill /F /IM RobloxNative.exe /T"]);
    crate::native::hide_window(&mut cmd);
    cmd.kill_on_drop(true);
    let _ = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await;
}

/// Stops the daemon and prevents anything from starting another one. Used at
/// app exit and before wiping the app-data folder (the running helper holds
/// its own exe file open, which would block the delete on Windows).
pub async fn shutdown(state: &AppState) {
    state.helper_shutdown.store(true, Ordering::SeqCst);
    let helper = state.helper.lock().await.take();
    if let Some(h) = helper {
        h.alive.store(false, Ordering::SeqCst);
        // Ask nicely first so it can stop its own threads; id 0 is the
        // no-reply fast path the read loop special-cases.
        {
            let mut w = h.stdin.lock().await;
            let _ = w.write_all(b"0|shutdown\n").await;
            let _ = w.flush().await;
        }
    }
    let child = state.helper_child.lock().unwrap().take();
    if let Some(mut child) = child {
        // Then make sure, and actually wait for the exit -- a still-running
        // helper keeps a handle on its own exe and on the singleton mutex.
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
        }
    }
    *state.watch_pid_cache.lock().unwrap() = None;
}

/// Synchronous best-effort stop for the app-exit path, where there's no
/// runtime left to await on.
///
/// Dropping the Helper closes our end of the daemon's stdin, which is what
/// lets it shut down *gracefully*: it sees EOF, stops its workers, and anti-AFK
/// restores the system-wide foreground-lock timeout on its way out. Killing it
/// outright skips all of that and leaves the machine altered, so the kill is
/// only a backstop for a daemon that doesn't go on its own.
pub fn shutdown_blocking(state: &AppState) {
    state.helper_shutdown.store(true, Ordering::SeqCst);
    // try_lock, not blocking_lock: this runs on the Tauri run-loop thread and
    // blocking_lock panics inside a runtime context -- with panic=abort that
    // would take the whole process down on the way out.
    if let Ok(mut guard) = state.helper.try_lock() {
        drop(guard.take());
    }
    if let Some(mut child) = state.helper_child.lock().unwrap().take() {
        for _ in 0..12 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return; // exited cleanly, cleanup ran
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.start_kill();
    }
}

/// True when the one helper process is up and holding the singleton mutex.
pub async fn is_holding_mutex(state: &AppState) -> bool {
    let helper = state.helper.lock().await.clone();
    match helper {
        Some(h) => h.alive() && h.mutex_held.load(Ordering::SeqCst),
        None => false,
    }
}
