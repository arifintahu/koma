//! On-screen browser wire types. GUI-owned wry surface; not Playwright.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

pub const MAX_TABS: usize = 16;
#[cfg(feature = "gui")]
pub const OBSERVATION_MAX_EDGE: u32 = 1920;
#[cfg(feature = "gui")]
pub const OBSERVATION_MAX_PIXELS: u64 = 2_073_600;
#[cfg(feature = "gui")]
pub const READ_MAX_CHARS: usize = 80_000;
pub const ACT_MAX: usize = 16;

#[cfg(feature = "gui")]
pub fn capture_size(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (0, 0);
    }
    let max_edge = f64::from(OBSERVATION_MAX_EDGE);
    let pixels = OBSERVATION_MAX_PIXELS as f64;
    let scale = 1.0_f64
        .min(max_edge / f64::from(width))
        .min(max_edge / f64::from(height))
        .min((pixels / (f64::from(width) * f64::from(height))).sqrt());
    (
        (f64::from(width) * scale).floor().max(1.0) as u32,
        (f64::from(height) * scale).floor().max(1.0) as u32,
    )
}

/// Content-tab URL policy: http(s) and about:blank only.
pub fn allow_content_url(url: &str) -> bool {
    let u = url.trim();
    if u.is_empty() {
        return false;
    }
    let lower = u.to_ascii_lowercase();
    if lower == "about:blank" || lower.starts_with("about:blank?") {
        return true;
    }
    if lower.starts_with("https://") || lower.starts_with("http://") {
        // Reject embedded credentials abuse and control chars.
        !u.chars().any(|c| c.is_control())
    } else {
        false
    }
}

/// True when the tab is the empty/new-tab shell (welcome page lives here).
#[cfg(any(feature = "gui", test))]
pub fn is_blank_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.is_empty() || lower == "about:blank" || lower.starts_with("about:blank?")
}

pub fn validate_content_url(url: &str) -> Result<()> {
    if allow_content_url(url) {
        Ok(())
    } else {
        bail!("url must be http://, https://, or about:blank (file: and other schemes are blocked)")
    }
}

/// Visual DuckDuckGo search used when the address bar is not a URL.
/// (`DEFAULT_SEARCH_ENGINE` is the HTML scrape endpoint — wrong for a real tab.)
#[cfg(any(feature = "gui", test))]
const OMNIBOX_DDG: &str = "https://duckduckgo.com/?q={query}";

/// True when wry/WKWebView can be given this string without `NSURL` unwrap-panic.
#[cfg(any(feature = "gui", test))]
pub fn webview_can_load_url(url: &str) -> bool {
    if is_blank_url(url) {
        return true;
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()
}

#[cfg(any(feature = "gui", test))]
pub fn duckduckgo_search_url(query: &str) -> String {
    crate::model::settings::build_search_url(OMNIBOX_DDG, query.trim()).unwrap_or_else(|_| {
        let encoded: String =
            url::form_urlencoded::byte_serialize(query.trim().as_bytes()).collect();
        format!("https://duckduckgo.com/?q={encoded}")
    })
}

/// RFC-ish DNS label: `a`, `a1`, `a-b` — not empty, not leading/trailing hyphen.
#[cfg(any(feature = "gui", test))]
fn is_dns_label(label: &str) -> bool {
    let b = label.as_bytes();
    if b.is_empty() || b.len() > 63 {
        return false;
    }
    if !b[0].is_ascii_alphanumeric() || !b[b.len() - 1].is_ascii_alphanumeric() {
        return false;
    }
    b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// Chrome-style host check: IP, localhost, or at least two DNS labels (`example.com`).
/// A single word (`hello`) is a search, even if `https://hello` parses as a URL.
/// A numeric port on a single label (`host:3000`) is treated as a LAN URL.
#[cfg(any(feature = "gui", test))]
fn host_is_navigable(host: &str, has_port: bool) -> bool {
    let host = host.trim();
    if host.is_empty() {
        return false;
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let labels: Vec<&str> = host.trim_end_matches('.').split('.').collect();
    if labels.len() < 2 {
        return has_port && is_dns_label(host);
    }
    labels.iter().copied().all(is_dns_label)
}

#[cfg(any(feature = "gui", test))]
fn has_http_scheme(raw: &str) -> bool {
    raw.get(..8)
        .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
        || raw
            .get(..7)
            .is_some_and(|s| s.eq_ignore_ascii_case("http://"))
}

/// Parse as a real http(s) page URL. `None` → caller should search instead.
#[cfg(any(feature = "gui", test))]
fn navigable_http_url(raw: &str) -> Option<String> {
    if raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let candidate = if has_http_scheme(raw) {
        raw.to_string()
    } else if raw.contains("://") {
        return None;
    } else {
        format!("https://{raw}")
    };
    let parsed = url::Url::parse(&candidate).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?;
    if !host_is_navigable(host, parsed.port().is_some()) {
        return None;
    }
    Some(candidate)
}

/// Address-bar input → content URL. Not a URL → DuckDuckGo search.
#[cfg(any(feature = "gui", test))]
pub fn resolve_omnibox_input(raw: &str) -> Result<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        bail!("url required");
    }
    if is_blank_url(raw) {
        return Ok("about:blank".into());
    }
    if let Some(url) = navigable_http_url(raw) {
        return Ok(url);
    }
    Ok(duckduckgo_search_url(raw))
}

/// Host from an http(s) URL (no port), lowercased — best-effort, no full parser.
#[cfg(any(feature = "gui", test))]
fn url_host_lower(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = u
        .strip_prefix("https://")
        .or_else(|| u.strip_prefix("http://"))
        .or_else(|| u.strip_prefix("HTTPS://"))
        .or_else(|| u.strip_prefix("HTTP://"))?;
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = hostport.split('@').next_back().unwrap_or(hostport);
    let host = host.split(':').next().unwrap_or(host).trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// Path (+ empty) from an http(s) URL, lowercased, no query/fragment.
#[cfg(any(feature = "gui", test))]
fn url_path_lower(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = u
        .strip_prefix("https://")
        .or_else(|| u.strip_prefix("http://"))
        .or_else(|| u.strip_prefix("HTTPS://"))
        .or_else(|| u.strip_prefix("HTTP://"))?;
    let after_host = rest.split_once('/')?.1;
    let path = after_host.split(['?', '#']).next().unwrap_or("");
    Some(format!("/{}", path).to_ascii_lowercase())
}

/// True when this `window.open` URL is **not** a user-facing document.
///
/// Mirrors how browsers treat auxiliary browsing contexts without hard-coding
/// any one site:
/// - `about:blank` shells need `window.opener` (we are not a real popup host)
/// - path segments starting with `_` are the widespread non-document convention
///   (GWT/SPA RPC frames, “/_/…” internal endpoints) — never a tab the user wants
/// - commercial ad/tracker network hosts (public suffix style), same class as
///   browser tracking protection — not first-party app logins
/// - common beacon path shapes (`/pagead/`, `/tr` pixels, …)
///
/// Real OAuth/login documents (`/signin`, `/oauth`, `/authorize`, …) do **not**
/// match these rules and still open as background tabs when policy allows.
#[cfg(any(feature = "gui", test))]
pub fn is_noise_popup_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower == "about:blank" || lower.starts_with("about:blank?") {
        // about:blank popups exist only to inherit opener — promoting them to a
        // tab breaks the site and leaves a useless empty tab.
        return true;
    }
    if let Some(path) = url_path_lower(trimmed) {
        // `/_foo`, `/_/bar`, `/x/_/y` — internal frame/RPC shells, not documents.
        if path
            .split('/')
            .filter(|s| !s.is_empty())
            .any(|seg| seg.starts_with('_'))
        {
            return true;
        }
    }
    let Some(host) = url_host_lower(trimmed) else {
        return false;
    };
    // Tracking / ads networks (suffix match). Site logins on accounts.* stay allowed.
    const TRACKER_SUFFIXES: &[&str] = &[
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "google-analytics.com",
        "googletagmanager.com",
        "googletagservices.com",
        "2mdn.net",
        "adsrvr.org",
        "adnxs.com",
        "adsystem.com",
        "amazon-adsystem.com",
        "scorecardresearch.com",
        "quantserve.com",
        "moatads.com",
        "outbrain.com",
        "taboola.com",
        "criteo.com",
        "pubmatic.com",
        "openx.net",
        "rubiconproject.com",
        "casalemedia.com",
        "bidswitch.net",
        "liadm.com",
        "ads-twitter.com",
        "facebook.net",
    ];
    if TRACKER_SUFFIXES
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
    {
        return true;
    }
    lower.contains("/pagead/")
        || lower.contains("/ads?")
        || lower.contains("/ads/")
        || lower.contains("facebook.com/tr")
        || lower.contains("/pixel")
        || lower.contains("/beacon")
}

/// Whether a page-initiated `window.open` should become a **tab**.
///
/// Real browsers use user-activation + window-features (size/toolbar) to tell
/// “popup” from “new tab”. wry only gives us the URL, so we:
/// 1. honor `popup_policy: block`
/// 2. drop non-document / tracker URLs ([`is_noise_popup_url`])
/// 3. otherwise open as a **background** tab (caller must not steal focus)
///
/// We never create an OS window (handler always returns false upstream).
#[cfg(any(feature = "gui", test))]
pub fn allow_popup_url(url: &str, popup_policy: &str) -> bool {
    if popup_policy.eq_ignore_ascii_case("block") {
        return false;
    }
    allow_content_url(url) && !is_noise_popup_url(url)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Capabilities {
    pub tabs: bool,
    pub capture: bool,
    pub input: bool,
    pub eval: bool,
    pub downloads: bool,
    pub floating: bool,
    pub limitations: Vec<String>,
}

impl Capabilities {
    #[cfg(feature = "gui")]
    pub fn gui_default(eval_allowed: bool) -> Self {
        Self {
            tabs: true,
            capture: true,
            input: true,
            eval: eval_allowed,
            downloads: true,
            floating: true,
            limitations: vec![
                "Uses the system webview (WKWebView / WebView2 / webkit2gtk), not Playwright Firefox."
                    .into(),
                "Available only in a local GUI session on the Main model.".into(),
                "Page evaluate requires the Settings toggle.".into(),
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabInfo {
    pub id: String,
    pub title: String,
    pub url: String,
    pub active: bool,
    pub loading: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    pub device_pixel_ratio: f64,
}

/// Maps observation image pixels to CSS viewport coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    pub width: u32,
    pub height: u32,
    pub css_width: f64,
    pub css_height: f64,
}

impl Transform {
    #[allow(dead_code)]
    pub fn image_to_css(&self, x: f64, y: f64) -> Result<(f64, f64)> {
        if self.width == 0 || self.height == 0 || !x.is_finite() || !y.is_finite() {
            bail!("invalid observation coordinates");
        }
        if x < 0.0 || y < 0.0 || x >= f64::from(self.width) || y >= f64::from(self.height) {
            bail!("coordinates outside observation image");
        }
        Ok((
            x * self.css_width / f64::from(self.width),
            y * self.css_height / f64::from(self.height),
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    pub id: String,
    pub session: String,
    pub generation: String,
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub transform: Transform,
    pub viewport: Viewport,
    pub captured_ms: u64,
    pub image_path: String,
    #[serde(default)]
    pub capture_quality: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Click {
        #[serde(default)]
        selector: Option<String>,
        #[serde(default)]
        x: Option<f64>,
        #[serde(default)]
        y: Option<f64>,
        #[serde(default)]
        button: ClickButton,
    },
    Dblclick {
        #[serde(default)]
        selector: Option<String>,
        #[serde(default)]
        x: Option<f64>,
        #[serde(default)]
        y: Option<f64>,
    },
    Hover {
        #[serde(default)]
        selector: Option<String>,
        #[serde(default)]
        x: Option<f64>,
        #[serde(default)]
        y: Option<f64>,
    },
    Scroll {
        #[serde(default)]
        selector: Option<String>,
        #[serde(default)]
        x: Option<f64>,
        #[serde(default)]
        y: Option<f64>,
        #[serde(default)]
        delta: Option<i32>,
        #[serde(default)]
        to: Option<String>,
    },
    Type {
        text: String,
        #[serde(default)]
        selector: Option<String>,
    },
    Key {
        keys: Vec<String>,
    },
    Wait {
        #[serde(default)]
        selector: Option<String>,
        #[serde(default)]
        url_contains: Option<String>,
        #[serde(default)]
        timeout_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClickButton {
    #[default]
    Left,
    Right,
    Double,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Tabs {
        action: String,
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        tab_id: Option<String>,
    },
    Observe {
        #[serde(default)]
        tab_id: Option<String>,
        #[serde(default)]
        full_page: bool,
    },
    Act {
        observation: String,
        #[serde(default)]
        tab_id: Option<String>,
        actions: Vec<Action>,
        #[serde(default = "yes")]
        observe: bool,
    },
    Read {
        #[serde(default)]
        tab_id: Option<String>,
        mode: String,
        #[serde(default)]
        selector: Option<String>,
        #[serde(default)]
        max_chars: Option<usize>,
    },
    Eval {
        #[serde(default)]
        tab_id: Option<String>,
        script: String,
        #[serde(default)]
        timeout_ms: Option<u64>,
    },
    WaitHuman {
        #[serde(default)]
        message: Option<String>,
    },
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub id: String,
    pub session: String,
    pub generation: String,
    pub operation: Operation,
    pub observation: Option<Observation>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    pub id: String,
    pub session: String,
    pub generation: String,
    pub completed: usize,
    pub uncertain: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub tabs: Vec<TabInfo>,
    pub observation: Option<Observation>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub json: Option<serde_json::Value>,
    /// One-shot IPC only; stripped before status projection.
    #[serde(default)]
    pub png: Vec<u8>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Prefs {
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default = "yes")]
    pub auto_screenshot: bool,
    #[serde(default = "yes")]
    pub stop_on_close: bool,
    #[serde(default)]
    pub allow_eval: bool,
    #[serde(default)]
    pub download_dir: Option<String>,
    /// "new_tab" (default) or "block"
    #[serde(default = "popup_default")]
    pub popup_policy: String,
}

fn popup_default() -> String {
    "new_tab".into()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Status {
    pub session: String,
    pub generation: String,
    pub enabled: bool,
    pub paused: bool,
    pub busy: bool,
    pub waiting_human: bool,
    pub window_open: bool,
    pub always_on_top: bool,
    pub capabilities: Capabilities,
    pub prefs: Prefs,
    #[serde(default)]
    pub tabs: Vec<TabInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_tab: Option<String>,
    pub observation: Option<Observation>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Control {
    /// GUI registers as the owner of the on-screen browser for this session.
    Enable {
        capabilities: Capabilities,
        prefs: Prefs,
    },
    Pause,
    Resume,
    TakeOver,
    Stop,
    OpenWindow,
    ClearData,
    SetPrefs {
        prefs: Prefs,
    },
    /// Continue after wait_human.
    ContinueHuman,
    /// GUI finished an operation.
    Result(Box<Reply>),
    /// Tab list / chrome state update from the window (non-operation).
    WindowState {
        window_open: bool,
        tabs: Vec<TabInfo>,
        active_tab: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_url_policy() {
        assert!(allow_content_url("https://example.com/a"));
        assert!(allow_content_url("http://localhost:3000"));
        assert!(allow_content_url("about:blank"));
        assert!(!allow_content_url("file:///etc/passwd"));
        assert!(!allow_content_url("javascript:alert(1)"));
        assert!(!allow_content_url("koma://localhost"));
    }

    fn assert_ddg(input: &str) {
        let u = resolve_omnibox_input(input).unwrap();
        assert!(
            u.starts_with("https://duckduckgo.com/?q="),
            "expected DDG for {input:?}, got {u}"
        );
    }

    #[test]
    fn omnibox_urls_pass_through() {
        assert_eq!(
            resolve_omnibox_input("https://example.com/a").unwrap(),
            "https://example.com/a"
        );
        assert_eq!(
            resolve_omnibox_input("example.com").unwrap(),
            "https://example.com"
        );
        assert_eq!(
            resolve_omnibox_input("localhost:3000").unwrap(),
            "https://localhost:3000"
        );
        assert_eq!(
            resolve_omnibox_input("127.0.0.1").unwrap(),
            "https://127.0.0.1"
        );
        assert_eq!(resolve_omnibox_input("about:blank").unwrap(), "about:blank");
        assert_eq!(
            resolve_omnibox_input("github.com/koma").unwrap(),
            "https://github.com/koma"
        );
    }

    #[test]
    fn omnibox_non_url_goes_to_duckduckgo() {
        assert_ddg("hello");
        assert_ddg("https://hello");
        assert_ddg("hello world");
        assert_ddg("https://hello world");
        assert_ddg("javascript:alert(1)");
        assert!(resolve_omnibox_input("").is_err());
        assert!(!webview_can_load_url("https://hello world"));
        assert!(!webview_can_load_url("file:///etc/passwd"));
        assert!(webview_can_load_url("https://example.com"));
        // `https://hello` is syntactically loadable — omnibox still searches it.
        assert!(webview_can_load_url("https://hello"));
        assert!(navigable_http_url("hello").is_none());
        assert!(navigable_http_url("https://hello").is_none());
        assert!(navigable_http_url("example.com").is_some());
    }

    #[test]
    fn noise_popup_blocks_helpers_not_login_documents() {
        let dc = "https://2507573.fls.doubleclick.net/activityi;dc_pre=x";
        assert!(is_noise_popup_url(dc));
        assert!(!allow_popup_url(dc, "new_tab"));
        assert!(!allow_popup_url("https://mail.google.com/", "block"));
        // Real login document — still allowed as a tab.
        assert!(allow_popup_url(
            "https://accounts.google.com/v3/signin/identifier?continue=https://mail.google.com",
            "new_tab"
        ));
        assert!(allow_popup_url(
            "https://github.com/login/oauth/authorize?client_id=x",
            "new_tab"
        ));
        // Internal non-document path segments (`/_/…`) — any host, not a vendor list.
        assert!(is_noise_popup_url("https://accounts.google.com/_/bscframe"));
        assert!(is_noise_popup_url("https://example.com/_/rpc/frame"));
        assert!(is_noise_popup_url("about:blank"));
        assert!(!allow_popup_url("about:blank", "new_tab"));
        assert!(!is_noise_popup_url("https://workspace.google.com/"));
    }

    #[test]
    fn transform_maps_image_to_css() {
        let t = Transform {
            width: 100,
            height: 50,
            css_width: 200.0,
            css_height: 100.0,
        };
        let (x, y) = t.image_to_css(25.0, 10.0).unwrap();
        assert!((x - 50.0).abs() < 1e-9);
        assert!((y - 20.0).abs() < 1e-9);
    }
}
