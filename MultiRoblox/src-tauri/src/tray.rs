// System-tray icon and the "hide to tray" close behaviour.
//
// The window is borderless (decorations:false in tauri.conf.json), so there is
// no OS close button; the titlebar's X calls window.close(), which raises
// CloseRequested exactly like a real one would. That single event is where the
// hide-vs-quit decision is made, so Alt+F4 and the custom X behave the same.
//
// The tray icon only exists while the setting is on. Leaving a dead icon in
// the notification area for an app that quits on close would be misleading,
// and Windows keeps showing a stale icon until something hovers it.
use crate::state::AppState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub const TRAY_ID: &str = "main-tray";

/// Reads the persisted toggle. Defaults to off: quitting on close is what the
/// app did before this existed, and silently minimising to tray instead is the
/// kind of surprise that gets an app labelled malware.
pub fn hide_to_tray_enabled() -> bool {
    crate::settings::load_settings()
        .get("hideToTray")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Builds the tray icon if it isn't already there. Idempotent, so the settings
/// toggle can call it freely.
pub fn ensure_tray(app: &AppHandle) -> Result<(), String> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let show = MenuItem::with_id(app, "tray-show", "Open MultiRoblox", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|e| e.to_string())?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("MultiRoblox")
        .menu(&menu)
        // Left click is handled below as "open the window"; without this the
        // menu pops on left click too, which is not the Windows convention.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_main_window(app),
            // The only path that actually terminates while hide-to-tray is on.
            // exit() runs RunEvent::Exit, so the helper is still shut down.
            "tray-quit" => {
                app.state::<AppState>()
                    .quitting
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_tray(app: &AppHandle) {
    let _ = app.remove_tray_by_id(TRAY_ID);
}

/// Called when the toggle changes: create or tear down the icon to match.
/// Turning it off while hidden would otherwise strand the window with no
/// taskbar entry and no tray icon, so the window is restored first.
pub fn apply_setting(app: &AppHandle, enabled: bool) {
    if enabled {
        if let Err(e) = ensure_tray(app) {
            eprintln!("[tray] could not create tray icon: {e}");
        }
    } else {
        show_main_window(app);
        remove_tray(app);
    }
}
