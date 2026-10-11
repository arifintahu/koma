//! On-screen browser wire types. GUI-owned wry surface; not Playwright.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

pub const MAX_TABS: usize = 16;
pub const OBSERVATION_MAX_EDGE: u32 = 1920;
pub const OBSERVATION_MAX_PIXELS: u64 = 2_073_600;
pub const READ_MAX_CHARS: usize = 80_000;
pub const ACT_MAX: usize = 16;

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
    if lower == "about:blank" {
        return true;
    }
    if lower.starts_with("https://") || lower.starts_with("http://") {
        // Reject embedded credentials abuse and control chars.
        !u.chars().any(|c| c.is_control())
    } else {
        false
    }
}

pub fn validate_content_url(url: &str) -> Result<()> {
    if allow_content_url(url) {
        Ok(())
    } else {
        bail!("url must be http://, https://, or about:blank (file: and other schemes are blocked)")
    }
}

/// Host from an http(s) URL (no port), lowercased — best-effort, no full parser.
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

/// Ad / beacon / pixel targets that sites `window.open` — not real user popups.
/// Opening these as tabs is pure noise (e.g. `*.fls.doubleclick.net` from Gmail).
pub fn is_noise_popup_url(url: &str) -> bool {
    let Some(host) = url_host_lower(url) else {
        return false;
    };
    const SUFFIXES: &[&str] = &[
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
        "fbcdn.net",
    ];
    if SUFFIXES.iter().any(|s| host == *s || host.ends_with(&format!(".{s}"))) {
        return true;
    }
    // Path beacons on first-party-looking hosts.
    let lower = url.to_ascii_lowercase();
    lower.contains("/pagead/")
        || lower.contains("/ads?")
        || lower.contains("google.com/ads")
        || lower.contains("facebook.com/tr")
}

/// Whether a page-initiated `window.open` should become a tab.
/// `popup_policy`: `"block"` rejects all; `"new_tab"` (default) opens real popups
/// and still drops tracker/ad noise.
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

    #[test]
    fn noise_popup_blocks_doubleclick_and_policy() {
        let dc = "https://2507573.fls.doubleclick.net/activityi;dc_pre=x";
        assert!(is_noise_popup_url(dc));
        assert!(!allow_popup_url(dc, "new_tab"));
        assert!(!allow_popup_url("https://mail.google.com/", "block"));
        assert!(allow_popup_url("https://mail.google.com/", "new_tab"));
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
