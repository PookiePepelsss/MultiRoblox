use crate::state::AppState;
use serde_json::Value;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// Roblox errors come back as {"errors":[{"code":N,"message":"..."}]} (or,
// on some endpoints, a flat {"message":"..."}) -- pull just the human
// message out instead of showing the raw JSON in the UI.
fn extract_roblox_error(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = v
            .get("errors")
            .and_then(|e| e.as_array())
            .and_then(|a| a.first())
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return msg.to_string();
        }
        if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
            return msg.to_string();
        }
    }
    body.chars().take(200).collect()
}

pub struct UserInfo {
    pub ok: bool,
    pub username: Option<String>,
    pub user_id: Option<String>,
    pub reason: Option<String>,
}

pub async fn fetch_user_info(state: &AppState, cookie: &str) -> UserInfo {
    let res = state
        .http
        .get("https://users.roblox.com/v1/users/authenticated")
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(8))
        .send()
        .await;
    match res {
        Ok(resp) => {
            let body = resp.text().await.unwrap_or_default();
            match serde_json::from_str::<Value>(&body) {
                Ok(d) if d.get("id").is_some() => UserInfo {
                    ok: true,
                    username: d
                        .get("name")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    user_id: d.get("id").map(|v| match v {
                        Value::Number(n) => n.to_string(),
                        Value::String(s) => s.clone(),
                        _ => String::new(),
                    }),
                    reason: None,
                },
                _ => UserInfo {
                    ok: false,
                    username: None,
                    user_id: None,
                    reason: Some(extract_roblox_error(&body)),
                },
            }
        }
        Err(e) => UserInfo {
            ok: false,
            username: None,
            user_id: None,
            reason: Some(e.to_string()),
        },
    }
}

// Err carries the failure reason so the caller can log why, not just fail.
// channel: None (or empty) checks the default production/LIVE channel via
// clientsettingscdn's JSON API. Some("zcanary") etc. checks that specific
// deployment channel instead -- clientsettingscdn's own `?channel=` query
// param is silently ignored (confirmed live: passing zcanary, zintegration,
// or a made-up channel name all return identical production data), so named
// channels go through setup.rbxcdn.com/channel/<name>/version instead,
// which returns the version hash as a plain-text body rather than JSON.
pub async fn get_roblox_version(state: &AppState, channel: Option<&str>) -> Result<String, String> {
    let channel = channel.filter(|c| !c.is_empty());
    let url = match channel {
        Some(ch) => format!("https://setup.rbxcdn.com/channel/{}/version", urlencoding::encode(ch)),
        None => "https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer".to_string(),
    };
    let res = state
        .http
        .get(&url)
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let status = res.status();
    if status != 200 {
        return Err(format!("unexpected status {status} -- unknown or restricted channel"));
    }
    if channel.is_some() {
        let text = res.text().await.map_err(|e| format!("bad response body: {e}"))?;
        let text = text.trim();
        if text.is_empty() || !text.starts_with("version-") {
            return Err("response wasn't a version hash".to_string());
        }
        return Ok(text.to_string());
    }
    let json: Value = res.json().await.map_err(|e| format!("bad response body: {e}"))?;
    json.get("clientVersionUpload")
        .or_else(|| json.get("version"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "response missing version field".to_string())
}

async fn csrf_from_endpoint(state: &AppState, cookie: &str, endpoint: &str) -> Option<String> {
    let url = format!("https://auth.roblox.com{}", endpoint);
    let res = state
        .http
        .post(&url)
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("User-Agent", UA)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("Content-Length", "0")
        .timeout(Duration::from_secs(8))
        .body("")
        .send()
        .await
        .ok()?;
    res.headers()
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

pub async fn get_csrf_token(state: &AppState, cookie: &str) -> Option<String> {
    {
        let cache = state.csrf_cache.lock().unwrap();
        if let Some((token, ts)) = cache.get(cookie) {
            if now_ms() - ts < 5 * 60_000 {
                return Some(token.clone());
            }
        }
    }
    for endpoint in ["/v2/logout", "/v1/logout"] {
        if let Some(token) = csrf_from_endpoint(state, cookie, endpoint).await {
            state
                .csrf_cache
                .lock()
                .unwrap()
                .insert(cookie.to_string(), (token.clone(), now_ms()));
            return Some(token);
        }
    }
    None
}

pub fn invalidate_csrf(state: &AppState, cookie: &str) {
    state.csrf_cache.lock().unwrap().remove(cookie);
}

pub struct TicketResult {
    pub ok: bool,
    pub ticket: Option<String>,
    pub error: Option<String>,
}

// Any non-429/403 status also gets backoff-and-retry across all 3 attempts.
pub async fn get_auth_ticket(
    state: &AppState,
    cookie: &str,
    csrf_token: Option<String>,
) -> TicketResult {
    let now = now_ms();
    let cached = {
        state
            .ticket_cache
            .lock()
            .unwrap()
            .get(cookie)
            .map(|(t, ts)| (t.clone(), *ts))
    };
    if let Some((ticket, ts)) = cached {
        if now - ts < 25_000 {
            return TicketResult {
                ok: true,
                ticket: Some(ticket),
                error: None,
            };
        }
        if now - ts < 8_000 {
            let wait = 8_000 - (now - ts);
            tokio::time::sleep(Duration::from_millis(wait as u64)).await;
        }
    }

    let mut token = csrf_token;
    let delays = [0u64, 2000, 5000];
    let mut last_status: u16 = 0;

    for attempt in 0..3 {
        if delays[attempt] > 0 {
            tokio::time::sleep(Duration::from_millis(delays[attempt])).await;
        }
        let mut req = state
            .http
            .post("https://auth.roblox.com/v1/authentication-ticket")
            .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
            .header("Referer", "https://www.roblox.com")
            .header("Origin", "https://www.roblox.com")
            .header("User-Agent", UA)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("Content-Length", "0")
            .timeout(Duration::from_secs(8))
            .body("");
        if let Some(t) = &token {
            req = req.header("X-CSRF-TOKEN", t.as_str());
        }
        let res = match req.send().await {
            Ok(r) => r,
            Err(_) => continue,
        };
        let status = res.status().as_u16();
        last_status = status;
        if let Some(ticket) = res
            .headers()
            .get("rbx-authentication-ticket")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
        {
            state
                .ticket_cache
                .lock()
                .unwrap()
                .insert(cookie.to_string(), (ticket.clone(), now_ms()));
            return TicketResult {
                ok: true,
                ticket: Some(ticket),
                error: None,
            };
        }
        if status == 429 {
            invalidate_csrf(state, cookie);
            let retry_after = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(8);
            tokio::time::sleep(Duration::from_secs(retry_after)).await;
            token = get_csrf_token(state, cookie).await;
            if token.is_none() {
                return TicketResult {
                    ok: false,
                    ticket: None,
                    error: Some(
                        "Rate limited and could not refresh token. Wait a moment and try again."
                            .into(),
                    ),
                };
            }
            continue;
        }
        if status == 403 {
            invalidate_csrf(state, cookie);
            token = get_csrf_token(state, cookie).await;
            if token.is_none() {
                return TicketResult {
                    ok: false,
                    ticket: None,
                    error: Some("Authentication failed (403). Cookie may be expired.".into()),
                };
            }
            continue;
        }
    }
    if last_status != 0 {
        return TicketResult {
            ok: false,
            ticket: None,
            error: Some(format!(
                "Auth ticket request failed (HTTP {}) after 3 attempts. Try again in a moment.",
                last_status
            )),
        };
    }
    TicketResult {
        ok: false,
        ticket: None,
        error: Some(
            "Still rate limited after 3 attempts. Please wait 30 seconds and try again.".into(),
        ),
    }
}

pub fn invalidate_ticket(state: &AppState, cookie: &str) {
    state.ticket_cache.lock().unwrap().remove(cookie);
}

fn extract_place_id(place_id_or_target: &str) -> Option<String> {
    let t = place_id_or_target.trim();
    if t.chars().all(|c| c.is_ascii_digit()) && !t.is_empty() {
        return Some(t.to_string());
    }
    let raw = if t.starts_with("http") {
        t.to_string()
    } else {
        format!("https://{}", t)
    };
    if let Ok(url) = url::Url::parse(&raw) {
        let segs: Vec<&str> = url
            .path_segments()
            .map(|s| s.filter(|x| !x.is_empty()).collect())
            .unwrap_or_default();
        if segs.first() == Some(&"games") {
            if let Some(id) = segs.get(1) {
                if id.chars().all(|c| c.is_ascii_digit()) {
                    return Some(id.to_string());
                }
            }
        }
        for (k, v) in url.query_pairs() {
            if k == "placeId" && v.chars().all(|c| c.is_ascii_digit()) {
                return Some(v.to_string());
            }
        }
    }
    None
}

async fn get_json(state: &AppState, url: &str, cookie: &str) -> Option<Value> {
    let res = state
        .http
        .get(url)
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("Accept", "application/json")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    res.json::<Value>().await.ok()
}

pub async fn get_game_name(
    state: &AppState,
    place_id_or_target: &str,
    cookie: &str,
) -> Option<String> {
    let place_id = extract_place_id(place_id_or_target)?;
    let url = format!(
        "https://games.roblox.com/v1/games/multiget-place-details?placeIds={}",
        place_id
    );
    if let Some(d) = get_json(state, &url, cookie).await {
        if let Some(name) = d
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
        {
            return Some(name.to_string());
        }
    }
    let uni = get_json(
        state,
        &format!(
            "https://apis.roblox.com/universes/v1/places/{}/universe",
            place_id
        ),
        cookie,
    )
    .await?;
    let universe_id = uni.get("universeId")?;
    let games = get_json(
        state,
        &format!(
            "https://games.roblox.com/v1/games?universeIds={}",
            universe_id
        ),
        cookie,
    )
    .await?;
    games
        .get("data")?
        .as_array()?
        .first()?
        .get("name")?
        .as_str()
        .map(|s| s.to_string())
}

pub async fn follow_redirect(state: &AppState, url: &str) -> String {
    match state
        .http_no_redirect
        .get(url)
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(8))
        .send()
        .await
    {
        Ok(res) => res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(url)
            .to_string(),
        Err(_) => url.to_string(),
    }
}

pub struct ShareLinkResult {
    pub ok: bool,
    pub place_id: Option<String>,
    pub link_code: Option<String>,
    pub error: Option<String>,
}

pub async fn resolve_share_link(
    state: &AppState,
    share_code: &str,
    cookie: &str,
    csrf_token: Option<&str>,
) -> ShareLinkResult {
    let payloads = [
        serde_json::json!({ "linkId": share_code, "linkType": "Server" }).to_string(),
        serde_json::json!({ "code": share_code, "type": "Server" }).to_string(),
    ];
    let mut current_csrf = csrf_token.map(|s| s.to_string()).unwrap_or_default();

    for payload in payloads {
        let (status, headers, body) = post_raw(
            state,
            "https://apis.roblox.com/sharelinks/v1/resolve-link",
            cookie,
            &current_csrf,
            &payload,
        )
        .await;
        if status == 200 {
            if let Some((pid, lc)) = extract_place_link(&body) {
                return ShareLinkResult {
                    ok: true,
                    place_id: Some(pid),
                    link_code: Some(lc),
                    error: None,
                };
            }
        }
        if status == 403 {
            if let Some(fresh) = headers.get("x-csrf-token").and_then(|v| v.to_str().ok()) {
                let (status2, _h2, body2) = post_raw(
                    state,
                    "https://apis.roblox.com/sharelinks/v1/resolve-link",
                    cookie,
                    fresh,
                    &payload,
                )
                .await;
                if status2 == 200 {
                    if let Some((pid, lc)) = extract_place_link(&body2) {
                        return ShareLinkResult {
                            ok: true,
                            place_id: Some(pid),
                            link_code: Some(lc),
                            error: None,
                        };
                    }
                }
                current_csrf = fresh.to_string();
            }
        }
    }
    ShareLinkResult {
        ok: false,
        place_id: None,
        link_code: None,
        error: Some("Could not resolve share link. It may be expired or invalid.".into()),
    }
}

// Compiled once; the patterns are constants and are exercised by the tests
// below, so the unwraps can only fire on first use.
static PLACE_ID_JSON_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r#""placeId"\s*:\s*(\d+)"#).unwrap());
static LINK_CODE_JSON_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    regex::Regex::new(
        r#""(?:linkCode|privateServerLinkCode|accessCode|linkcode)"\s*:\s*"([A-Za-z0-9_\-]+)""#,
    )
    .unwrap()
});
static ACCESS_CODE_QUERY_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"[?&]accessCode=([^&]+)").unwrap());

fn extract_place_link(body: &str) -> Option<(String, String)> {
    let pid = PLACE_ID_JSON_RE.captures(body)?.get(1)?.as_str().to_string();
    let lc = LINK_CODE_JSON_RE.captures(body)?.get(1)?.as_str().to_string();
    Some((pid, lc))
}

async fn post_raw(
    state: &AppState,
    url: &str,
    cookie: &str,
    csrf: &str,
    body: &str,
) -> (u16, reqwest::header::HeaderMap, String) {
    let res = state
        .http
        .post(url)
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("X-CSRF-TOKEN", csrf)
        .header("Content-Type", "application/json")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(8))
        .body(body.to_string())
        .send()
        .await;
    match res {
        Ok(r) => {
            let status = r.status().as_u16();
            let headers = r.headers().clone();
            let body = r.text().await.unwrap_or_default();
            (status, headers, body)
        }
        Err(_) => (0, reqwest::header::HeaderMap::new(), String::new()),
    }
}

pub async fn get_access_code(
    state: &AppState,
    place_id: &str,
    link_code: &str,
    cookie: &str,
    csrf_token: &str,
) -> Option<String> {
    let body = serde_json::json!({ "shareCode": link_code, "shareType": "Server" }).to_string();
    let res = state
        .http
        .post("https://apis.roblox.com/sharelinks/v1/resolve")
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("X-CSRF-TOKEN", csrf_token)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Origin", "https://www.roblox.com")
        .header("Referer", "https://www.roblox.com")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(8))
        .body(body)
        .send()
        .await;
    if let Ok(r) = res {
        if let Ok(d) = r.json::<Value>().await {
            let code = d
                .get("privateServerInviteData")
                .or_else(|| {
                    d.get("resolvedShareData")
                        .and_then(|v| v.get("privateServerInviteData"))
                })
                .or_else(|| {
                    d.get("experienceInviteData")
                        .and_then(|v| v.get("privateServerInviteData"))
                })
                .and_then(|v| v.get("accessCode"))
                .and_then(|v| v.as_str());
            if let Some(code) = code {
                return Some(code.to_string());
            }
        }
    }

    // Fallback: redirect scrape.
    let url = format!(
        "https://www.roblox.com/games/{}?privateServerLinkCode={}",
        place_id, link_code
    );
    let res = state
        .http_no_redirect
        .get(&url)
        .header("Cookie", format!(".ROBLOSECURITY={}", cookie))
        .header("Referer", "https://www.roblox.com")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    let loc = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())?;
    ACCESS_CODE_QUERY_RE
        .captures(loc)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

// Proxied through Rust since *.roblox.com sends no CORS headers and a
// renderer-side fetch() would get blocked.
pub async fn get_json_public(state: &AppState, url: &str) -> Result<Value, String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    let host = parsed.host_str().unwrap_or("");
    if !(host == "roblox.com" || host.ends_with(".roblox.com")) {
        return Err("host not allowed".into());
    }
    let res = state
        .http
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let ok = res.status().is_success();
    let data: Value = res.json().await.unwrap_or(Value::Null);
    Ok(serde_json::json!({ "ok": ok, "status": status, "data": data }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn place_id_from_a_bare_id() {
        assert_eq!(extract_place_id("1818"), Some("1818".into()));
        assert_eq!(extract_place_id("  1818  "), Some("1818".into()));
    }

    #[test]
    fn place_id_from_game_urls() {
        for input in [
            "https://www.roblox.com/games/1818/Classic-Crossroads",
            "www.roblox.com/games/1818/Classic-Crossroads",
            "https://www.roblox.com/games/1818",
        ] {
            assert_eq!(extract_place_id(input), Some("1818".into()), "failed for {}", input);
        }
    }

    #[test]
    fn place_id_from_a_query_parameter() {
        assert_eq!(
            extract_place_id("https://www.roblox.com/games/start?placeId=1818"),
            Some("1818".into())
        );
    }

    #[test]
    fn place_id_rejects_non_numeric_and_junk() {
        assert_eq!(extract_place_id(""), None);
        assert_eq!(extract_place_id("not a link"), None);
        assert_eq!(extract_place_id("https://www.roblox.com/games/abc/Name"), None);
        assert_eq!(extract_place_id("https://www.roblox.com/users/1818/profile"), None);
    }

    #[test]
    fn roblox_errors_use_the_human_message() {
        assert_eq!(
            extract_roblox_error(r#"{"errors":[{"code":0,"message":"Token Validation Failed"}]}"#),
            "Token Validation Failed"
        );
        assert_eq!(extract_roblox_error(r#"{"message":"Too many requests"}"#), "Too many requests");
    }

    #[test]
    fn non_json_errors_fall_back_to_a_truncated_body() {
        assert_eq!(extract_roblox_error("<html>502</html>"), "<html>502</html>");
        let long = "x".repeat(500);
        assert_eq!(extract_roblox_error(&long).len(), 200, "body is capped");
    }

    #[test]
    fn share_link_extraction_needs_both_ids() {
        let body = r#"{"placeId":1818,"linkCode":"abc-DEF_123"}"#;
        assert_eq!(extract_place_link(body), Some(("1818".into(), "abc-DEF_123".into())));
        assert_eq!(extract_place_link(r#"{"placeId":1818}"#), None, "no link code");
        assert_eq!(extract_place_link(r#"{"linkCode":"abc"}"#), None, "no place id");
    }

    #[test]
    fn share_link_accepts_the_other_code_field_names() {
        for field in ["privateServerLinkCode", "accessCode", "linkcode"] {
            let body = format!(r#"{{"placeId":7,"{}":"zzz"}}"#, field);
            assert_eq!(extract_place_link(&body), Some(("7".into(), "zzz".into())), "failed for {}", field);
        }
    }
}

// Same CORS gap as roblox.com above -- see altgen.me/docs/generate-accounts.
pub async fn altgen_generate(
    state: &AppState,
    api_key: &str,
    quantity: i64,
) -> Result<Value, String> {
    let body = serde_json::json!({ "type": "ROBLOX_NORMAL", "quantity": quantity.clamp(1, 100) });
    let res = state
        .http
        .post("https://api.altgen.me/api/v1/generate")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .timeout(Duration::from_secs(15))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let data: Value = res.json().await.unwrap_or(Value::Null);
    Ok(serde_json::json!({ "status": status, "data": data }))
}

// ---- follow user ----
// Resolves a username to the place/server they're currently in, so an account
// can be launched straight into it. Two hops: username -> userId, then
// presence -> placeId + gameId (the job/server id).
//
// Roblox only reports placeId/gameId here when the target's "who can see me
// online" privacy setting allows it AND they're in a joinable public server,
// so a "not joinable" result is frequently the target's own privacy/server
// state rather than a lookup failure -- the distinct messages below matter
// for the user being able to tell those apart.
pub async fn follow_user_target(
    state: &AppState,
    cookie: &str,
    username: &str,
) -> Result<Value, String> {
    let name = username.trim().trim_start_matches('@');
    if name.is_empty() {
        return Err("Enter a username".into());
    }

    let csrf = get_csrf_token(state, cookie)
        .await
        .ok_or_else(|| "Could not authenticate (cookie may be expired)".to_string())?;

    // 1. username -> userId
    let body = serde_json::json!({
        "usernames": [name],
        "excludeBannedUsers": false
    })
    .to_string();
    let (status, _h, resp) = post_raw(
        state,
        "https://users.roblox.com/v1/usernames/users",
        cookie,
        &csrf,
        &body,
    )
    .await;
    if status != 200 {
        return Err(format!("Username lookup failed (HTTP {})", status));
    }
    let json: Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    let user = json
        .get("data")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| format!("No Roblox user named \"{}\"", name))?;
    let user_id = user
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "Unexpected username lookup response".to_string())?;
    let real_name = user
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(name)
        .to_string();

    // 2. userId -> current presence
    let body = serde_json::json!({ "userIds": [user_id] }).to_string();
    let (status, _h, resp) = post_raw(
        state,
        "https://presence.roblox.com/v1/presence/users",
        cookie,
        &csrf,
        &body,
    )
    .await;
    if status != 200 {
        return Err(format!("Presence lookup failed (HTTP {})", status));
    }
    let json: Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    let p = json
        .get("userPresences")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "Unexpected presence response".to_string())?;

    // 0 Offline, 1 Online (site/app, not in a game), 2 InGame, 3 InStudio.
    let ptype = p.get("userPresenceType").and_then(|v| v.as_i64()).unwrap_or(0);
    if ptype != 2 {
        return Err(format!("{} is not in a game right now", real_name));
    }

    let place_id = p.get("placeId").and_then(|v| v.as_i64());
    let job_id = p.get("gameId").and_then(|v| v.as_str());
    match (place_id, job_id) {
        (Some(pid), Some(jid)) if !jid.is_empty() => Ok(serde_json::json!({
            "username": real_name,
            "target": format!("{}:{}", pid, jid),
        })),
        // In a game, but Roblox withheld the server details -- that's the
        // target's join-privacy setting, not an error on our side.
        _ => Err(format!(
            "{} is in a game, but their server isn't joinable (their privacy settings may hide it)",
            real_name
        )),
    }
}
