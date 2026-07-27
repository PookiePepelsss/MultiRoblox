// Account instance screenshots, optionally cropped to a per-account outlined
// region, delivered to a Discord webhook. No files touch disk -- the resident
// helper's "capture" request returns the PNG as base64 on the same pipe it
// serves everything else (see RobloxNative.cs), so this module just
// decodes/re-encodes bytes in memory.
use crate::state::AppState;
use tauri::AppHandle;

pub async fn capture_account_png(app: &AppHandle, state: &AppState, account_id: &str, region: Option<(f64, f64, f64, f64)>) -> Result<Vec<u8>, String> {
    let pid = state
        .account_pids
        .lock()
        .unwrap()
        .get(account_id)
        .copied()
        .ok_or_else(|| "No running instance for this account".to_string())?;

    let cmd = match region {
        // Always '.' as the decimal separator; the helper parses these with
        // the invariant culture to match.
        Some((x, y, w, h)) => format!("capture|{}|{}|{}|{}|{}", pid, x, y, w, h),
        None => format!("capture|{}", pid),
    };
    let b64 = crate::helper::call(app, state, &cmd, crate::helper::CAPTURE_TIMEOUT).await?;

    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| e.to_string())
}

pub async fn capture_preview_b64(app: &AppHandle, state: &AppState, account_id: &str) -> Result<String, String> {
    let png = capture_account_png(app, state, account_id, None).await?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&png))
}

// Screenshots of a logged-in game session are about as sensitive as this app
// gets, and the destination is free text in the UI. Restrict it to real
// Discord webhook endpoints so a typo -- or a URL pasted from somewhere else
// -- can't quietly ship captures to a third party.
const DISCORD_WEBHOOK_HOSTS: [&str; 6] = [
    "discord.com",
    "www.discord.com",
    "canary.discord.com",
    "ptb.discord.com",
    "discordapp.com",
    "www.discordapp.com",
];

pub fn validate_webhook_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim())
        .map_err(|_| "That doesn't look like a URL. Paste the full Discord webhook URL.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("The webhook URL must start with https://".to_string());
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if !DISCORD_WEBHOOK_HOSTS.contains(&host.as_str()) {
        return Err(format!(
            "Only Discord webhooks are allowed, but this points at {}.",
            if host.is_empty() { "no host" } else { &host }
        ));
    }
    if !parsed.path().starts_with("/api/webhooks/") {
        return Err("That's a Discord URL but not a webhook - it should look like https://discord.com/api/webhooks/...".to_string());
    }
    Ok(())
}

// Discord's multi-attachment webhook format: each file gets its own part
// named files[0], files[1], etc, all in one POST -- one message per capture
// pass instead of spamming a separate message per outlined spot.
pub async fn send_to_discord_webhook(state: &AppState, webhook_url: &str, images: Vec<Vec<u8>>, content: &str) -> Result<(), String> {
    let mut form = reqwest::multipart::Form::new().text("content", content.to_string());
    for (i, image) in images.into_iter().enumerate() {
        let part = reqwest::multipart::Part::bytes(image)
            .file_name(format!("screenshot-{}.png", i + 1))
            .mime_str("image/png")
            .map_err(|e| e.to_string())?;
        form = form.part(format!("files[{}]", i), part);
    }
    let resp = state.http.post(webhook_url).multipart(form).send().await.map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(format!("Webhook returned {}: {}", status, body.chars().take(300).collect::<String>()))
    }
}

pub async fn capture_and_send(
    app: &AppHandle,
    state: &AppState,
    account_id: &str,
    username: &str,
    webhook_url: &str,
    regions: Vec<(f64, f64, f64, f64)>,
) -> Result<(), String> {
    // Checked before capturing, not just before sending: no point taking a
    // screenshot we're not allowed to deliver.
    validate_webhook_url(webhook_url)?;
    let mut images = Vec::new();
    if regions.is_empty() {
        images.push(capture_account_png(app, state, account_id, None).await?);
    } else {
        for region in regions {
            images.push(capture_account_png(app, state, account_id, Some(region)).await?);
        }
    }
    let content = format!("**{}** \u{2014} {}", username, chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC"));
    send_to_discord_webhook(state, webhook_url, images, &content).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_real_discord_webhooks() {
        for url in [
            "https://discord.com/api/webhooks/123456/abcDEF-_123",
            "https://canary.discord.com/api/webhooks/1/t",
            "https://ptb.discord.com/api/webhooks/1/t",
            "https://discordapp.com/api/webhooks/1/t",
            "  https://discord.com/api/webhooks/1/t  ",
        ] {
            assert!(validate_webhook_url(url).is_ok(), "rejected {}", url);
        }
    }

    #[test]
    fn rejects_other_hosts() {
        for url in [
            "https://example.com/api/webhooks/1/t",
            "https://discord.com.evil.test/api/webhooks/1/t",
            "https://notdiscord.com/api/webhooks/1/t",
            "https://discord.evil.com/api/webhooks/1/t",
        ] {
            assert!(validate_webhook_url(url).is_err(), "accepted {}", url);
        }
    }

    #[test]
    fn rejects_plaintext_http() {
        assert!(validate_webhook_url("http://discord.com/api/webhooks/1/t").is_err());
    }

    #[test]
    fn rejects_discord_urls_that_are_not_webhooks() {
        assert!(validate_webhook_url("https://discord.com/channels/1/2").is_err());
        assert!(validate_webhook_url("https://discord.com/").is_err());
    }

    #[test]
    fn rejects_junk() {
        for url in ["", "   ", "not a url", "discord.com/api/webhooks/1/t"] {
            assert!(validate_webhook_url(url).is_err(), "accepted {:?}", url);
        }
    }
}
