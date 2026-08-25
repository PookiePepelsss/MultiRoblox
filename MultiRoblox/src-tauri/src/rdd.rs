// Native port of RDD (Roblox Deployment Downloader, rdd.weao.xyz).
//
// The web version builds a zip in the browser with JSZip and hands it to the
// user to extract by hand; there is no server endpoint that returns a finished
// build. So this does the same work the page's JS does: read the package
// manifest for a version hash, pull each package off Roblox's setup CDN, and
// unpack it into the layout Roblox expects. Installing straight into the
// Versions folder is the part the web tool can't do.
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const HOST: &str = "https://setup-aws.rbxcdn.com";

// Package -> subdirectory under the version folder. Mirrors extractRoots.player
// in rdd.js; a package missing from here is one the player build doesn't use.
const PLAYER_ROOTS: &[(&str, &str)] = &[
    ("RobloxApp.zip", ""),
    ("redist.zip", ""),
    ("shaders.zip", "shaders/"),
    ("ssl.zip", "ssl/"),
    ("WebView2.zip", ""),
    ("WebView2RuntimeInstaller.zip", "WebView2RuntimeInstaller/"),
    ("content-avatar.zip", "content/avatar/"),
    ("content-configs.zip", "content/configs/"),
    ("content-fonts.zip", "content/fonts/"),
    ("content-sky.zip", "content/sky/"),
    ("content-sounds.zip", "content/sounds/"),
    ("content-textures2.zip", "content/textures/"),
    ("content-models.zip", "content/models/"),
    ("content-platform-fonts.zip", "PlatformContent/pc/fonts/"),
    (
        "content-platform-dictionaries.zip",
        "PlatformContent/pc/shared_compression_dictionaries/",
    ),
    ("content-terrain.zip", "PlatformContent/pc/terrain/"),
    ("content-textures3.zip", "PlatformContent/pc/textures/"),
    ("extracontent-luapackages.zip", "ExtraContent/LuaPackages/"),
    ("extracontent-translations.zip", "ExtraContent/translations/"),
    ("extracontent-models.zip", "ExtraContent/models/"),
    ("extracontent-textures.zip", "ExtraContent/textures/"),
    ("extracontent-places.zip", "ExtraContent/places/"),
];

const APP_SETTINGS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Settings>\n    <ContentFolder>content</ContentFolder>\n    <BaseUrl>http://www.roblox.com</BaseUrl>\n</Settings>\n";

pub fn versions_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").ok()?;
    Some(
        Path::new(&home)
            .join("AppData")
            .join("Local")
            .join("Roblox")
            .join("Versions"),
    )
}

pub fn normalize_hash(raw: &str) -> Option<String> {
    let h = raw.trim();
    let h = h.strip_prefix("version-").unwrap_or(h);
    if h.len() == 16 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(format!("version-{}", h.to_ascii_lowercase()))
    } else {
        None
    }
}

fn progress(app: &AppHandle, done: usize, total: usize, msg: &str) {
    let _ = app.emit(
        "rdd:progress",
        serde_json::json!({ "done": done, "total": total, "message": msg }),
    );
}

pub async fn install_version(
    app: &AppHandle,
    state: &AppState,
    raw_hash: &str,
) -> Result<serde_json::Value, String> {
    let hash = normalize_hash(raw_hash)
        .ok_or_else(|| "Not a valid version hash (expected 16 hex characters)".to_string())?;
    let base =
        versions_dir().ok_or_else(|| "Could not locate the Roblox Versions folder".to_string())?;
    let dest = base.join(&hash);

    if dest.join("RobloxPlayerBeta.exe").exists() {
        return Ok(serde_json::json!({ "ok": true, "version": hash, "alreadyInstalled": true }));
    }

    progress(app, 0, 1, "Fetching manifest");
    let manifest_url = format!("{}/{}-rbxPkgManifest.txt", HOST, hash);
    let res = state
        .http
        .get(&manifest_url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    if res.status() == 403 || res.status() == 404 {
        return Err(format!("No such Roblox version: {}", hash));
    }
    if !res.status().is_success() {
        return Err(format!("Manifest fetch returned {}", res.status()));
    }
    let manifest = res.text().await.map_err(|e| format!("bad manifest: {e}"))?;

    // Same filter rdd.js uses: the manifest interleaves package names with
    // their hashes and sizes, so take only the lines that name a .zip.
    let listed: Vec<String> = manifest
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.contains('.') && l.ends_with(".zip"))
        .map(|l| l.to_string())
        .collect();
    if listed.is_empty() {
        return Err("Manifest had no packages (is that hash a Windows player build?)".into());
    }

    let wanted: Vec<(&str, &str)> = PLAYER_ROOTS
        .iter()
        .filter(|(pkg, _)| listed.iter().any(|l| l == pkg))
        .copied()
        .collect();
    let total = wanted.len() + 1;

    std::fs::create_dir_all(&dest)
        .map_err(|e| format!("could not create {}: {e}", dest.display()))?;

    for (i, (pkg, sub)) in wanted.iter().enumerate() {
        progress(app, i, total, pkg);
        let url = format!("{}/{}-{}", HOST, hash, pkg);
        let bytes = state
            .http
            .get(&url)
            .timeout(Duration::from_secs(180))
            .send()
            .await
            .map_err(|e| format!("{pkg}: network error: {e}"))?
            .error_for_status()
            .map_err(|e| format!("{pkg}: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("{pkg}: download failed: {e}"))?;

        let out_dir = if sub.is_empty() {
            dest.clone()
        } else {
            dest.join(sub.trim_end_matches('/').replace('/', std::path::MAIN_SEPARATOR_STR))
        };
        // The zip crate is sync; keep it off the async workers.
        tokio::task::spawn_blocking(move || extract_zip(&bytes, &out_dir))
            .await
            .map_err(|e| format!("{pkg}: extract task failed: {e}"))?
            .map_err(|e| format!("{pkg}: {e}"))?;
    }

    // Roblox refuses to start a version folder that doesn't have this.
    std::fs::write(dest.join("AppSettings.xml"), APP_SETTINGS)
        .map_err(|e| format!("could not write AppSettings.xml: {e}"))?;
    progress(app, total, total, "Done");

    if !dest.join("RobloxPlayerBeta.exe").exists() {
        return Err("Install finished but RobloxPlayerBeta.exe is missing".into());
    }
    Ok(serde_json::json!({ "ok": true, "version": hash, "alreadyInstalled": false }))
}

fn extract_zip(bytes: &[u8], out_dir: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // Roblox's packages use backslash separators, which enclosed_name()
        // rejects outright -- using it here would silently skip most entries.
        let raw = entry.name().replace('\\', "/");
        if raw.ends_with('/') {
            continue;
        }
        // Refuse anything trying to climb out of the version folder.
        if raw.split('/').any(|p| p == ".." || p.contains(':')) {
            continue;
        }
        let path = out_dir.join(raw.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every locally installed player build, newest first.
pub fn list_versions() -> Vec<serde_json::Value> {
    let Some(base) = versions_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut out: Vec<(std::time::SystemTime, serde_json::Value)> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("version-") {
            continue;
        }
        let exe = e.path().join("RobloxPlayerBeta.exe");
        let Ok(meta) = std::fs::metadata(&exe) else {
            continue;
        };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let installed = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push((
            mtime,
            serde_json::json!({ "version": name, "installedAt": installed }),
        ));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, v)| v).collect()
}

pub fn delete_version(raw_hash: &str) -> Result<(), String> {
    let hash = normalize_hash(raw_hash).ok_or_else(|| "Not a valid version hash".to_string())?;
    let base =
        versions_dir().ok_or_else(|| "Could not locate the Roblox Versions folder".to_string())?;
    let dir = base.join(&hash);
    if !dir.exists() {
        return Err("That version isn't installed".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove {}: {e}", dir.display()))
}
