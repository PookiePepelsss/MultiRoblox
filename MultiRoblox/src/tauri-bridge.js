// Reimplements the exact `window.api` surface the old Electron preload.js
// exposed, on top of Tauri's invoke/listen, so renderer.js needed zero
// call-site changes when the app moved off Electron.
(() => {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;
  const win = T.window.getCurrentWindow();

  window.api = {
    minimize: () => win.minimize(),
    maximize: () => win.toggleMaximize(),
    close: () => win.close(),

    loadAccounts: () => invoke('accounts_load'),
    addAccount: (account) => invoke('accounts_add', { account }),
    removeAccount: (id) => invoke('accounts_remove', { id }),
    updateAccount: (id, data) => invoke('accounts_update', { id, data }),
    reorderAccounts: (ids) => invoke('accounts_reorder', { ids }),

    loadPackages: () => invoke('packages_load'),
    savePackages: (packages) => invoke('packages_save', { packages }),

    openLogin: () => invoke('roblox_open_login'),
    loginWithCredentials: (username, password) => invoke('roblox_login_with_credentials', { username, password }),
    openAccountInBrowser: (cookie) => invoke('roblox_open_account_browser', { cookie }),
    cancelLogin: () => invoke('login_cancel'),
    validateCookie: (cookie) => invoke('roblox_validate_cookie', { cookie }),

    setRobloxVolume: (percent) => invoke('roblox_set_volume', { percent }),
    killAllRoblox: () => invoke('roblox_kill_all'),
    killOneRoblox: (id) => invoke('roblox_kill_one', { id }),
    getRunningCount: () => invoke('roblox_running_count'),
    getWatchedIds: () => invoke('roblox_watched_ids'),
    trimRobloxMemory: () => invoke('roblox_trim_memory'),
    trimAccountMemory: (id) => invoke('roblox_trim_account_memory', { id }),
    setAccountPriority: (id, priority) => invoke('roblox_set_account_priority', { id, priority }),
    onAllRobloxClosed: (cb) => listen('roblox:allClosed', () => cb()),

    launchRoblox: (id, cookie, target) => invoke('roblox_launch', { id, cookie, target }),
    cancelLaunch: (id) => invoke('roblox_launch_cancel', { id }),
    openExternal: (url) => invoke('open_external', { url }),
    getAppVersion: () => invoke('app_version'),

    trackingCapturePreview: (id) => invoke('tracking_capture_preview', { id }),
    trackingCaptureAndSend: (id, username, webhookUrl, regions) => invoke('tracking_capture_and_send', { id, username, webhookUrl, regions }),
    trackingValidateWebhook: (url) => invoke('tracking_validate_webhook', { url }),

    loadSettings: () => invoke('settings_load'),
    saveSettings: (data) => invoke('settings_save', { data }),

    encStatus: () => invoke('enc_status'),
    encUnlock: (pass) => invoke('enc_unlock', { pass }),
    encSetKey: (pass) => invoke('enc_set_key', { pass }),
    clearAppData: () => invoke('clear_app_data'),

    multiInstanceStatus: () => invoke('multiinstance_status'),
    antiAfkStatus: () => invoke('antiafk_status'),

    readGenHistory: () => invoke('genhistory_read'),
    writeGenHistory: (list) => invoke('genhistory_write', { list }),
    clearGenHistory: () => invoke('genhistory_clear'),

    readFFlags: () => invoke('fflag_read'),
    writeFFlags: (flags) => invoke('fflag_write', { flags }),
    readFpsCap: () => invoke('fps_read'),
    writeFpsCap: (cap) => invoke('fps_write', { cap }),

    onChromeProgress: (cb) => listen('chrome:download-progress', (e) => cb(e.payload)),
    onRobloxClosed: (cb) => listen('roblox:closed', (e) => cb(e.payload)),
    onRobloxStarted: (cb) => listen('roblox:started', (e) => cb(e.payload)),
    onRobloxCount: (cb) => listen('roblox:count', (e) => cb(e.payload)),
    onLogEntry: (cb) => listen('log:entry', (e) => cb(e.payload)),

    getRobloxVersion: (channel) => invoke('roblox_get_version', { channel: channel || null }),
    rddInstall: (hash) => invoke('rdd_install', { hash }),
    rddListVersions: () => invoke('rdd_list_versions'),
    rddDeleteVersion: (hash) => invoke('rdd_delete_version', { hash }),
    onRddProgress: (cb) => listen('rdd:progress', (e) => cb(e.payload)),
    getGameName: (placeId, cookie) => invoke('roblox_get_game_name', { placeIdOrTarget: placeId, cookie }),
    // *.roblox.com sends no CORS headers; fetch() from the webview's real
    // https://tauri.localhost origin gets blocked (Electron's file:// origin was
    // exempt from this, which is why this needs a Rust-side detour).
    // Returns { ok, status, data } to mirror the fetch()+r.json() shape callers used.
    robloxGet: (url) => invoke('roblox_get_json', { url }),
    followUser: (cookie, username) => invoke('roblox_follow_user', { cookie, username }),
    // api.altgen.me sends no Access-Control-Allow-Origin either; same CORS
    // gap as robloxGet above. Returns { status, data } (data is the API's own
    // { success, message/error, data } JSON body).
    altgenGenerate: (apiKey, quantity) => invoke('altgen_generate', { apiKey, quantity }),
  };

  // Electron version showed the BrowserWindow only once the page had painted
  // (win.once('ready-to-show', ...)). Tauri's window starts hidden the same
  // way (see tauri.conf.json "visible": false); reveal it once the DOM is
  // actually ready instead of on window creation, so there's no white flash.
  const reveal = () => invoke('show_main_window').catch(() => {});
  if (document.readyState === 'complete' || document.readyState === 'interactive') reveal();
  else document.addEventListener('DOMContentLoaded', reveal);
})();
