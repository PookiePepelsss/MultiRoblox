mod commands;
mod crypto;
mod encryption;
mod helper;
mod jsonfile;
mod login;
mod native;
mod paths;
mod roblox_api;
mod settings;
mod state;
mod storage;
mod tracking;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState::new(handle.clone()));

            {
                let state = app.state::<AppState>();
                encryption::init_encryption(&state);
                storage::migrate_account_encryption_to_keychain(&state);
            }
            encryption::prewarm_key(&handle);

            // Best-effort cleanup of orphaned login-profile temp dirs from a
            // crash or force-kill mid-login (see sweep_stale_login_profiles).
            // Blocking I/O, kept off the async runtime's worker threads.
            std::thread::spawn(login::sweep_stale_login_profiles);

            // Start the one and only RobloxNative.exe here, at app startup --
            // not lazily when an account launches. It stays up for the whole
            // session holding Roblox's singleton mutex, and everything else
            // (anti-AFK, PID watching, handle closing, volume, captures) is a
            // request on its pipe rather than another process.
            //
            // Paint the UI immediately (window is created with visible:false
            // and shown by the frontend's show_main_window call once DOM is
            // ready); bring the helper up in the background so a cold start
            // never blocks first paint. The launch path independently awaits
            // the helper's READY before every launch, so the mutex is still
            // guaranteed held before any instance launches.
            if cfg!(windows) {
                let handle2 = handle.clone();
                let startup_settings = settings::load_settings();
                let auto_afk = startup_settings
                    .get("antiAfk")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                // Defaults on, matching the previous unconditional hold. Only
                // an explicit false releases it -- until now the setting was
                // read solely when toggled, so a saved `false` came back on at
                // every restart.
                let multi_instance = startup_settings
                    .get("multiInstance")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                tauri::async_runtime::spawn(async move {
                    let state = handle2.state::<AppState>();
                    native::start_mutex_holder(&handle2, &state).await;
                    if !multi_instance {
                        native::set_multi_instance(&handle2, &state, false).await;
                    }
                    // Sequenced after the helper is up, so anti-AFK doesn't
                    // race the spawn and end up starting a second one.
                    if auto_afk {
                        native::start_antiafk(&handle2, &state).await;
                    }
                });
            }

            // Safety net: the window is created with visible:false and normally
            // revealed by the frontend's show_main_window call once the DOM is
            // ready (see tauri-bridge.js). If the frontend fails to boot at all
            // -- WebView2 hiccup, window.__TAURI__ not injected yet, any throw
            // before the reveal runs -- that call never fires and the app just
            // sits there as an invisible background process with no way for the
            // user to recover. Force the window visible after a few seconds
            // regardless, so a broken frontend surfaces itself instead of
            // silently running headless. show_main_window is idempotent, so the
            // normal (fast) frontend path having already shown it is harmless.
            let handle4 = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                if let Some(w) = handle4.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::show_main_window,
            commands::settings_load,
            commands::settings_save,
            commands::enc_status,
            commands::enc_unlock,
            commands::enc_set_key,
            commands::clear_app_data,
            commands::multiinstance_status,
            commands::antiafk_status,
            commands::accounts_load,
            commands::accounts_add,
            commands::accounts_remove,
            commands::accounts_update,
            commands::accounts_reorder,
            commands::packages_load,
            commands::packages_save,
            commands::genhistory_read,
            commands::genhistory_write,
            commands::genhistory_clear,
            commands::fflag_read,
            commands::fflag_write,
            commands::fps_read,
            commands::fps_write,
            commands::roblox_get_version,
            commands::roblox_validate_cookie,
            commands::roblox_set_volume,
            commands::roblox_kill_all,
            commands::roblox_kill_one,
            commands::roblox_running_count,
            commands::roblox_watched_ids,
            commands::roblox_trim_memory,
            commands::roblox_trim_account_memory,
            commands::roblox_set_account_priority,
            commands::roblox_get_game_name,
            commands::roblox_get_json,
            commands::altgen_generate,
            commands::roblox_launch,
            commands::roblox_launch_cancel,
            commands::roblox_open_login,
            commands::roblox_open_account_browser,
            commands::login_cancel,
            commands::open_external,
            commands::app_version,
            commands::tracking_capture_preview,
            commands::tracking_capture_and_send,
            commands::tracking_validate_webhook,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    // On Windows, closing a secondary WebviewWindow (e.g. the
                    // login webview) can fire ExitRequested even while the main
                    // window is still alive -- a WebView2 WM_QUIT quirk. Prevent
                    // exit whenever the main window is still present; if the user
                    // closed the main window itself it's already destroyed here
                    // and we fall through to a normal exit.
                    if app_handle.get_webview_window("main").is_some() {
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Exit => {
                    // Take the helper down with us. Synchronous on purpose:
                    // there's no runtime left to await on here, and deferring
                    // into a spawn would race the process actually exiting.
                    // Even if this somehow doesn't land, closing our end of
                    // its stdin gives the daemon EOF and it exits itself --
                    // which is also what covers a crash or a Task Manager
                    // kill, where none of this code runs at all.
                    let state = app_handle.state::<AppState>();
                    helper::shutdown_blocking(&state);
                }
                _ => {}
            }
        });
}
