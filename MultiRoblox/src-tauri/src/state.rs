use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tokio::process::Child;

pub struct AppState {
    pub app_handle: AppHandle,
    pub http: reqwest::Client,
    pub http_no_redirect: reqwest::Client,

    pub session_pass: Mutex<Option<String>>,
    pub cached_key: Mutex<Option<[u8; 32]>>,
    pub cached_legacy_key: Mutex<Option<[u8; 32]>>,

    // The one resident RobloxNative.exe (see helper.rs). It replaces what used
    // to be a separate child per concern -- mutex holder, anti-AFK, PID
    // watcher -- plus a fresh one-shot process per launch for closehandles and
    // per slider move for volume.
    pub helper: tokio::sync::Mutex<Option<Arc<crate::helper::Helper>>>,
    pub helper_child: Mutex<Option<Child>>,
    pub helper_shutdown: AtomicBool,
    pub helper_swept: AtomicBool,
    pub helper_restarts: Mutex<Vec<i64>>,
    pub helper_next_attempt: Mutex<i64>,
    pub antiafk_on: AtomicBool,

    pub native_helper_path: Mutex<Option<Option<std::path::PathBuf>>>, // Some(None) = unavailable
    pub account_pids: Mutex<HashMap<String, u32>>,
    pub manual_priority: Mutex<HashMap<String, String>>,
    pub watched_accounts: Mutex<HashMap<String, i64>>,
    pub miss_counts: Mutex<HashMap<String, u32>>,
    pub watch_handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub auto_relaunch_history: Mutex<HashMap<String, Vec<i64>>>,
    pub watch_pid_cache: Mutex<Option<std::collections::HashSet<u32>>>,

    pub csrf_cache: Mutex<HashMap<String, (String, i64)>>,
    pub ticket_cache: Mutex<HashMap<String, (String, i64)>>,
    pub last_launch_ts: Mutex<i64>,
    pub launch_lock: tokio::sync::Mutex<()>,
    /// account id -> flag the UI can set to abandon an in-flight launch.
    pub launch_cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,

    pub login_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            // connect_timeout only -- deliberately NOT a whole-request
            // timeout. A host that blackholes packets (firewall drop, dead
            // DNS) otherwise leaves a connect attempt hanging indefinitely,
            // and callers that aren't individually timeout-wrapped just stop.
            // A request timeout would cap the whole exchange including the
            // body, which would break the Chrome download in login.rs -- it
            // streams a several-hundred-MB zip through this same client.
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client"),
            http_no_redirect: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client (no redirect)"),
            session_pass: Mutex::new(None),
            cached_key: Mutex::new(None),
            cached_legacy_key: Mutex::new(None),
            helper: tokio::sync::Mutex::new(None),
            helper_child: Mutex::new(None),
            helper_shutdown: AtomicBool::new(false),
            helper_swept: AtomicBool::new(false),
            helper_restarts: Mutex::new(Vec::new()),
            helper_next_attempt: Mutex::new(0),
            antiafk_on: AtomicBool::new(false),
            native_helper_path: Mutex::new(None),
            account_pids: Mutex::new(HashMap::new()),
            manual_priority: Mutex::new(HashMap::new()),
            watched_accounts: Mutex::new(HashMap::new()),
            miss_counts: Mutex::new(HashMap::new()),
            watch_handle: Mutex::new(None),
            auto_relaunch_history: Mutex::new(HashMap::new()),
            watch_pid_cache: Mutex::new(None),
            csrf_cache: Mutex::new(HashMap::new()),
            ticket_cache: Mutex::new(HashMap::new()),
            last_launch_ts: Mutex::new(0),
            launch_lock: tokio::sync::Mutex::new(()),
            launch_cancel: Mutex::new(HashMap::new()),
            login_cancel: Mutex::new(None),
        }
    }
}
