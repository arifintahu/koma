//! Detached multi-tab on-screen browser window (wry), owned by the GUI event loop.
use super::proto::UserEvent;
use crate::app::runtime::{
    client::HostCtl,
    screen_browser::{
        allow_content_url, validate_content_url, Action, Observation, Operation, Request, Reply,
        Status, TabInfo, Transform, Viewport, MAX_TABS,
    },
};
use anyhow::{bail, Context, Result};
use std::time::{SystemTime, UNIX_EPOCH};
use tao::{
    dpi::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize},
    event_loop::EventLoopWindowTarget,
    window::{Window, WindowBuilder},
};
use wry::{NewWindowResponse, PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder};

/// Fallback chrome strip height (tabs + address bar). Overwritten when the
/// chrome webview reports its measured height so no black gap remains.
const CHROME_H_DEFAULT: f64 = 70.0;

/// Desktop browser UA so sites treat the page like a normal browser (not a bot/webview).
/// macOS uses a Safari-shaped UA (we are WKWebView) so Google WebAuthn/passkey prompts
/// align with the real engine; Chromium UA on Windows/Linux matches WebView2 / webkitgtk quirks less.
fn chrome_user_agent() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15"
    }
    #[cfg(target_os = "windows")]
    {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    }
    #[cfg(target_os = "linux")]
    {
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15"
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Placement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    always_on_top: bool,
}

struct Tab {
    id: String,
    webview: WebView,
    title: String,
    url: String,
    loading: bool,
    error: Option<String>,
}

pub(super) struct BrowserWindow {
    pub window: Window,
    chrome: WebView,
    tabs: Vec<Tab>,
    active: Option<String>,
    /// Logical height of the chrome strip (tabs + toolbar). Matches measured UI.
    chrome_h: f64,
    /// Kept alive so content webviews share cookies/storage.
    #[allow(dead_code)]
    context: WebContext,
    preferences: Option<std::path::PathBuf>,
    profile_dir: std::path::PathBuf,
    /// `store::pwd_hash` of the workdir this profile belongs to.
    pwd_hash: String,
    ctl: std::sync::mpsc::Sender<HostCtl>,
    status: Status,
    always_on_top: bool,
}

impl BrowserWindow {
    pub fn new(
        target: &EventLoopWindowTarget<UserEvent>,
        status: &Status,
        palette: &serde_json::Value,
        ctl: std::sync::mpsc::Sender<HostCtl>,
        workdir: &std::path::Path,
    ) -> Result<Self> {
        // Cookies/storage live under the project pwd bucket so every session with
        // the same workdir reuses logins. Tabs stay ephemeral (closed on stop).
        let hash = crate::model::store::pwd_hash(workdir);
        let profile_dir = crate::model::store::screen_browser_profile_dir(&hash)
            .context("screen-browser profile dir")?;
        let preferences = crate::model::store::screen_browser_window_path(&hash).ok();
        let saved = preferences
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|v| serde_json::from_slice::<Placement>(&v).ok());
        let always_on_top = status.prefs.always_on_top
            || saved.as_ref().map(|s| s.always_on_top).unwrap_or(false);
        let mut builder = WindowBuilder::new()
            .with_title("Koma · Browser")
            .with_inner_size(PhysicalSize::new(1100, 760))
            .with_min_inner_size(PhysicalSize::new(480, 320))
            .with_focused(true)
            .with_always_on_top(always_on_top);
        if let Some(p) = &saved {
            if p.width >= 480 && p.width <= 4000 && p.height >= 320 && p.height <= 4000 {
                builder = builder.with_inner_size(PhysicalSize::new(p.width, p.height));
                let visible = target.available_monitors().any(|m| {
                    let o = m.position();
                    let s = m.size();
                    p.x >= o.x
                        && p.y >= o.y
                        && i64::from(p.x) < i64::from(o.x) + i64::from(s.width)
                        && i64::from(p.y) < i64::from(o.y) + i64::from(s.height)
                });
                if visible {
                    builder = builder.with_position(PhysicalPosition::new(p.x, p.y));
                }
            }
        }
        let window = builder.build(target)?;
        let mut context = WebContext::new(Some(profile_dir.clone()));
        let initial = serde_json::to_string(status)?;
        let ctl_chrome = ctl.clone();
        // Chrome is a *child* strip only — never a full-window webview (that painted
        // white over the page and made takeSnapshot look empty).
        let chrome_builder = WebViewBuilder::new_with_web_context(&mut context)
            .with_url("koma://localhost/index.html#screen-browser")
            .with_bounds(Rect {
                position: LogicalPosition::new(0.0, 0.0).into(),
                size: LogicalSize::new(1100.0, CHROME_H_DEFAULT).into(),
            })
            .with_background_color((11, 14, 20, 255))
            .with_navigation_handler(|url| super::allow_webview_navigation(&url))
            .with_initialization_script(format!(
                "window.__komaScreenBrowserInitial={initial};window.__komaScreenBrowserPalette={palette};\
                 window.addEventListener('koma-screen-browser',()=>{{}});\
                 document.addEventListener('DOMContentLoaded',()=>{{try{{window.dispatchEvent(new CustomEvent('koma-screen-browser',{{detail:window.__komaScreenBrowserInitial}}));}}catch(e){{}}}});\
                 (function(){{const report=()=>{{try{{const root=document.querySelector('main')||document.body; if(!root) return; const h=Math.ceil(root.getBoundingClientRect().height); if(h>0) window.ipc&&window.ipc.postMessage(JSON.stringify({{t:'sb',a:'chrome_metrics',h}}));}}catch(e){{}}}}; window.addEventListener('load',report); window.addEventListener('resize',report); new ResizeObserver(report).observe(document.documentElement); setTimeout(report,0); setTimeout(report,50); setTimeout(report,200);}})();"
            ))
            .with_custom_protocol("koma".into(), |_, request| super::handle_koma_request(request))
            .with_ipc_handler(move |request| {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(request.body()) else {
                    return;
                };
                let action = value
                    .get("a")
                    .or_else(|| value.get("action"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if action.is_empty() {
                    return;
                }
                let url = value
                    .get("url")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
                    .or_else(|| {
                        // chrome_metrics sends height as `h`
                        value.get("h").and_then(|v| v.as_f64()).map(|h| h.to_string())
                    });
                let tab_id = value
                    .get("tab_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                let _ = ctl_chrome.send(HostCtl::ScreenBrowserChrome {
                    action: action.into(),
                    url,
                    tab_id,
                });
            });

        #[cfg(target_os = "linux")]
        let chrome = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            chrome_builder.build_gtk(
                window
                    .default_vbox()
                    .ok_or_else(|| anyhow::anyhow!("browser GTK container unavailable"))?,
            )?
        };
        #[cfg(not(target_os = "linux"))]
        let chrome = chrome_builder.build_as_child(&window)?;

        let mut browser = Self {
            window,
            chrome,
            tabs: Vec::new(),
            active: None,
            chrome_h: CHROME_H_DEFAULT,
            context,
            preferences,
            profile_dir,
            pwd_hash: hash,
            ctl,
            status: status.clone(),
            always_on_top,
        };
        browser.open_tab(Some("about:blank".into()), true)?;
        browser.layout()?;
        browser.push_status();
        Ok(browser)
    }

    pub fn apply_status(&mut self, status: Status) {
        self.status = status.clone();
        if status.always_on_top != self.always_on_top {
            self.always_on_top = status.always_on_top;
            self.window.set_always_on_top(self.always_on_top);
        }
        let _ = self.chrome.evaluate_script(&format!(
            "window.dispatchEvent(new CustomEvent('koma-screen-browser',{{detail:{}}}));",
            serde_json::to_string(&status).unwrap_or_else(|_| "null".into())
        ));
        if !status.enabled {
            // Host will drop the window.
        }
    }

    pub fn always_on_top(&self) -> bool {
        self.always_on_top
    }

    /// Project key this window's cookies/storage belong to (`store::pwd_hash`).
    pub fn pwd_hash(&self) -> &str {
        &self.pwd_hash
    }

    pub fn resized(&mut self) {
        let _ = self.layout();
        self.save();
    }

    pub fn save(&self) {
        let Some(path) = &self.preferences else {
            return;
        };
        let size = self.window.inner_size();
        let pos = self.window.outer_position().unwrap_or_default();
        let placement = Placement {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            always_on_top: self.always_on_top,
        };
        if let Ok(bytes) = serde_json::to_vec_pretty(&placement) {
            let _ = std::fs::write(path, bytes);
        }
    }

    fn layout(&mut self) -> Result<()> {
        let size = self.window.inner_size();
        let scale = self.window.scale_factor();
        let logical_w = size.width as f64 / scale;
        let logical_h = size.height as f64 / scale;
        let chrome_h = self.chrome_h.clamp(48.0, logical_h.max(48.0));
        let _ = self.chrome.set_bounds(Rect {
            position: LogicalPosition::new(0.0, 0.0).into(),
            size: LogicalSize::new(logical_w, chrome_h.min(logical_h)).into(),
        });
        let content_h = (logical_h - chrome_h).max(40.0);
        let active = self.active.clone();
        for tab in &self.tabs {
            let is_active = Some(tab.id.as_str()) == active.as_deref();
            let _ = tab.webview.set_visible(is_active);
            if is_active {
                let _ = tab.webview.set_bounds(Rect {
                    position: LogicalPosition::new(0.0, chrome_h).into(),
                    size: LogicalSize::new(logical_w, content_h).into(),
                });
            }
        }
        Ok(())
    }

    fn open_tab(&mut self, url: Option<String>, activate: bool) -> Result<String> {
        if self.tabs.len() >= MAX_TABS {
            bail!("tab limit ({MAX_TABS}) reached");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let start = url.unwrap_or_else(|| "about:blank".into());
        validate_content_url(&start)?;
        let id_nav = id.clone();
        let id_load = id.clone();
        let id_title = id.clone();
        let ctl = self.ctl.clone();
        let ctl_load = self.ctl.clone();
        let ctl_title = self.ctl.clone();
        let size = self.window.inner_size();
        let scale = self.window.scale_factor();
        let logical_w = size.width as f64 / scale;
        let logical_h = size.height as f64 / scale;
        let chrome_h = self.chrome_h;
        let content_h = (logical_h - chrome_h).max(40.0);
        // GPU compositing is on by default in WKWebView / WebView2 / WebKitGTK.
        // WebGPU is available when the OS webview supports it (Safari 17+ / Edge 113+).
        let builder = WebViewBuilder::new_with_web_context(&mut self.context)
            .with_url(&start)
            .with_user_agent(chrome_user_agent())
            .with_background_color((255, 255, 255, 255))
            .with_back_forward_navigation_gestures(true)
            .with_bounds(Rect {
                position: LogicalPosition::new(0.0, chrome_h).into(),
                size: LogicalSize::new(logical_w.max(200.0), content_h).into(),
            })
            .with_navigation_handler(move |u| {
                let ok = allow_content_url(&u);
                if !ok {
                    let _ = ctl.send(HostCtl::ScreenBrowserChrome {
                        action: "nav_blocked".into(),
                        url: Some(u),
                        tab_id: Some(id_nav.clone()),
                    });
                }
                ok
            })
            .with_on_page_load_handler(move |event, url| {
                let action = match event {
                    PageLoadEvent::Started => "page_started",
                    PageLoadEvent::Finished => "page_finished",
                };
                let _ = ctl_load.send(HostCtl::ScreenBrowserChrome {
                    action: action.into(),
                    url: Some(url),
                    tab_id: Some(id_load.clone()),
                });
            })
            .with_document_title_changed_handler(move |title| {
                let _ = ctl_title.send(HostCtl::ScreenBrowserChrome {
                    action: "page_title".into(),
                    url: Some(title),
                    tab_id: Some(id_title.clone()),
                });
            })
            .with_new_window_req_handler({
                let ctl = self.ctl.clone();
                move |u, _features| {
                    // Always deny a native OS window. Real popups become tabs via
                    // "popup"; ad/tracker beacons are dropped in handle_chrome.
                    // (wry >=0.55 only calls this for window.open / target=_blank,
                    // not for iframe navigations as 0.52 did on macOS.)
                    if allow_content_url(&u) {
                        let _ = ctl.send(HostCtl::ScreenBrowserChrome {
                            action: "popup".into(),
                            url: Some(u),
                            tab_id: None,
                        });
                    }
                    NewWindowResponse::Deny
                }
            });

        #[cfg(target_os = "linux")]
        let webview = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            builder.build_gtk(
                self.window
                    .default_vbox()
                    .ok_or_else(|| anyhow::anyhow!("browser GTK container unavailable"))?,
            )?
        };
        // Content tabs are child webviews so the page sits under the chrome strip
        // (Chrome multi-tab style) and native takeSnapshot sees real page pixels.
        #[cfg(not(target_os = "linux"))]
        let webview = builder.build_as_child(&self.window)?;

        let loading = start != "about:blank";
        self.tabs.push(Tab {
            id: id.clone(),
            webview,
            title: if start == "about:blank" {
                "New Tab".into()
            } else {
                start.clone()
            },
            url: start,
            loading,
            error: None,
        });
        if activate {
            self.active = Some(id.clone());
        }
        self.layout()?;
        self.push_status();
        Ok(id)
    }

    fn tab_mut(&mut self, tab_id: Option<&str>) -> Result<&mut Tab> {
        let id = tab_id
            .map(str::to_owned)
            .or_else(|| self.active.clone())
            .ok_or_else(|| anyhow::anyhow!("no active tab"))?;
        self.tabs
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| anyhow::anyhow!("unknown tab_id"))
    }

    fn tab_infos(&self) -> Vec<TabInfo> {
        self.tabs
            .iter()
            .map(|t| TabInfo {
                id: t.id.clone(),
                title: t.title.clone(),
                url: t.url.clone(),
                active: Some(t.id.as_str()) == self.active.as_deref(),
                loading: t.loading,
                favicon: None,
                error: t.error.clone(),
            })
            .collect()
    }

    fn push_status(&self) {
        let _ = self.ctl.send(HostCtl::ScreenBrowser {
            action: "window_state".into(),
            window: None,
            prefs: None,
            url: None,
            tab_id: None,
            tabs: Some(self.tab_infos()),
            active_tab: self.active.clone(),
            window_open: true,
            reply: None,
        });
        let mut status = self.status.clone();
        status.tabs = self.tab_infos();
        status.active_tab = self.active.clone();
        status.window_open = true;
        let _ = self.chrome.evaluate_script(&format!(
            "window.dispatchEvent(new CustomEvent('koma-screen-browser',{{detail:{}}}));",
            serde_json::to_string(&status).unwrap_or_else(|_| "null".into())
        ));
    }

    pub fn handle_chrome(
        &mut self,
        action: &str,
        url: Option<String>,
        tab_id: Option<String>,
    ) -> Result<()> {
        match action {
            "open" => {
                self.open_tab(url, true)?;
            }
            "popup" => {
                // Page `window.open` — honor prefs + drop ad/tracker noise so Gmail
                // (etc.) does not spawn a second tab for doubleclick beacons.
                let u = url.unwrap_or_default();
                if crate::app::runtime::screen_browser::allow_popup_url(
                    &u,
                    &self.status.prefs.popup_policy,
                ) {
                    // Background tab: don't steal focus from the page that opened it.
                    self.open_tab(Some(u), false)?;
                }
            }
            "close" => {
                let id = tab_id.or_else(|| self.active.clone());
                if let Some(id) = id {
                    self.tabs.retain(|t| t.id != id);
                    if self.active.as_deref() == Some(id.as_str()) {
                        self.active = self.tabs.last().map(|t| t.id.clone());
                    }
                    if self.tabs.is_empty() {
                        self.open_tab(Some("about:blank".into()), true)?;
                    } else {
                        self.layout()?;
                        self.push_status();
                    }
                }
            }
            "select" => {
                if let Some(id) = tab_id {
                    if self.tabs.iter().any(|t| t.id == id) {
                        self.active = Some(id);
                        self.layout()?;
                        self.push_status();
                    }
                }
            }
            "navigate" => {
                let mut u = url.ok_or_else(|| anyhow::anyhow!("url required"))?;
                // User address bar: bare hosts get https:// (same as chrome UI).
                if !u.contains("://") && u != "about:blank" {
                    u = format!("https://{u}");
                }
                validate_content_url(&u)?;
                let tab = self.tab_mut(tab_id.as_deref())?;
                tab.url = u.clone();
                tab.title = u.clone();
                tab.loading = true;
                tab.error = None;
                tab.webview.load_url(&u)?;
                self.push_status();
            }
            "reload" => {
                let tab = self.tab_mut(tab_id.as_deref())?;
                let u = tab.url.clone();
                tab.loading = true;
                tab.error = None;
                tab.webview.load_url(&u)?;
                self.push_status();
            }
            "stop" => {
                // best-effort via JS
                let tab = self.tab_mut(tab_id.as_deref())?;
                let _ = tab.webview.evaluate_script("window.stop()");
                tab.loading = false;
                self.push_status();
            }
            "back" => {
                let tab = self.tab_mut(tab_id.as_deref())?;
                tab.loading = true;
                let _ = tab.webview.evaluate_script("history.back()");
                self.push_status();
            }
            "forward" => {
                let tab = self.tab_mut(tab_id.as_deref())?;
                tab.loading = true;
                let _ = tab.webview.evaluate_script("history.forward()");
                self.push_status();
            }
            "page_started" => {
                if let Some(id) = tab_id {
                    if let Some(t) = self.tabs.iter_mut().find(|t| t.id == id) {
                        t.loading = true;
                        if let Some(u) = url.filter(|u| allow_content_url(u)) {
                            t.url = u;
                        }
                        t.error = None;
                    }
                    self.push_status();
                }
            }
            "page_finished" => {
                if let Some(id) = tab_id {
                    if let Some(t) = self.tabs.iter_mut().find(|t| t.id == id) {
                        t.loading = false;
                        if let Some(u) = url.filter(|u| allow_content_url(u)) {
                            t.url = u;
                        }
                    }
                    self.push_status();
                }
            }
            "page_title" => {
                if let Some(id) = tab_id {
                    if let Some(t) = self.tabs.iter_mut().find(|t| t.id == id) {
                        if let Some(title) = url.filter(|s| !s.trim().is_empty()) {
                            t.title = title;
                        }
                    }
                    self.push_status();
                }
            }
            "chrome_metrics" => {
                // `url` carries the measured height string from the IPC bridge.
                if let Some(h) = url.and_then(|s| s.parse::<f64>().ok()) {
                    // Clamp: toolbar is never tiny and never most of the window.
                    let next = h.clamp(48.0, 160.0);
                    if (next - self.chrome_h).abs() >= 0.5 {
                        self.chrome_h = next;
                        let _ = self.layout();
                    }
                }
            }
            "pause" | "resume" | "take_over" | "stop_browser" | "continue_human" => {
                let mapped = match action {
                    "stop_browser" => "stop",
                    other => other,
                };
                let _ = self.ctl.send(HostCtl::ScreenBrowser {
                    action: mapped.into(),
                    window: None,
                    prefs: None,
                    url: None,
                    tab_id: None,
                    tabs: None,
                    active_tab: None,
                    window_open: true,
                    reply: None,
                });
            }
            "nav_blocked" => {
                if let Some(id) = tab_id {
                    if let Some(t) = self.tabs.iter_mut().find(|t| t.id == id) {
                        t.error = Some(format!(
                            "Blocked navigation: {}",
                            url.unwrap_or_default()
                        ));
                        t.loading = false;
                    }
                    self.push_status();
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn execute(&mut self, request: Request) -> Reply {
        let mut reply = Reply {
            id: request.id.clone(),
            session: request.session.clone(),
            generation: request.generation.clone(),
            ..Default::default()
        };
        let result = (|| -> Result<()> {
            match &request.operation {
                Operation::Tabs {
                    action,
                    url,
                    tab_id,
                } => {
                    match action.as_str() {
                        "list" => {}
                        "open" => {
                            self.open_tab(url.clone(), true)?;
                        }
                        "close" => self.handle_chrome("close", None, tab_id.clone())?,
                        "select" => self.handle_chrome("select", None, tab_id.clone())?,
                        "navigate" => self.handle_chrome("navigate", url.clone(), tab_id.clone())?,
                        "reload" => self.handle_chrome("reload", None, tab_id.clone())?,
                        "stop" => self.handle_chrome("stop", None, tab_id.clone())?,
                        "back" => self.handle_chrome("back", None, tab_id.clone())?,
                        "forward" => self.handle_chrome("forward", None, tab_id.clone())?,
                        other => bail!("unknown tabs action {other}"),
                    }
                    reply.tabs = self.tab_infos();
                    reply.completed = 1;
                }
                Operation::Observe { tab_id, full_page } => {
                    let obs = self.observe(tab_id.as_deref(), *full_page)?;
                    reply.observation = Some(obs.0);
                    reply.png = obs.1;
                    reply.tabs = self.tab_infos();
                    reply.completed = 1;
                }
                Operation::Act {
                    observation: _,
                    tab_id,
                    actions,
                    observe,
                } => {
                    let completed = self.run_actions(tab_id.as_deref(), actions)?;
                    reply.completed = completed;
                    if *observe {
                        let obs = self.observe(tab_id.as_deref(), false)?;
                        reply.observation = Some(obs.0);
                        reply.png = obs.1;
                    }
                    reply.tabs = self.tab_infos();
                }
                Operation::Read {
                    tab_id,
                    mode,
                    selector,
                    max_chars,
                } => {
                    let text = self.read_page(
                        tab_id.as_deref(),
                        mode,
                        selector.as_deref(),
                        max_chars.unwrap_or(crate::app::runtime::screen_browser::READ_MAX_CHARS),
                    )?;
                    reply.text = Some(text);
                    reply.tabs = self.tab_infos();
                    reply.completed = 1;
                }
                Operation::Eval {
                    tab_id,
                    script,
                    timeout_ms: _,
                } => {
                    let tab = self.tab_mut(tab_id.as_deref())?;
                    // Return value via wry's JSON callback (works macOS/Windows/Linux).
                    let result = capture::js_eval(
                        &tab.webview,
                        &format!("(function(){{\n{script}\n}})()"),
                    )?;
                    if result.contains("\"__koma_err\"") {
                        reply.error = Some(result);
                    } else {
                        reply.text = Some(result);
                        reply.completed = 1;
                    }
                }
                Operation::WaitHuman { .. } => {
                    // handled daemon-side
                }
            }
            Ok(())
        })();
        if let Err(e) = result {
            reply.error = Some(e.to_string());
        }
        reply.tabs = if reply.tabs.is_empty() {
            self.tab_infos()
        } else {
            reply.tabs
        };
        reply
    }

    fn observe(&mut self, tab_id: Option<&str>, full_page: bool) -> Result<(Observation, Vec<u8>)> {
        {
            let tab = self.tab_mut(tab_id)?;
            if let Ok(u) = tab.webview.url() {
                if allow_content_url(&u) {
                    tab.url = u;
                }
            }
            let _ = tab.webview.evaluate_script(
                "try { window.__komaSbTitle = document.title || ''; } catch (e) {}",
            );
        }
        let chrome_h = self.chrome_h;
        let (tab_id_s, url, title) = {
            let tab = self.tab_mut(tab_id)?;
            (tab.id.clone(), tab.url.clone(), tab.title.clone())
        };
        // Chrome-style visible-tab capture: the page content webview only
        // (no koma chrome, no OS window chrome).
        let (png, quality) = {
            let tab = self.tab_mut(Some(&tab_id_s))?;
            match capture::snapshot_tab(&tab.webview, full_page) {
                Ok(p) if !p.is_empty() => (p, "webview"),
                Ok(_) | Err(_) => {
                    let fallback = capture::snapshot_content_region(&self.window, chrome_h)?;
                    (fallback, "window")
                }
            }
        };
        if png.is_empty() {
            bail!("page screenshot unavailable");
        }
        let (w, h) = image_size(&png).unwrap_or((1280, 720));
        let (tw, th) = crate::app::runtime::screen_browser::capture_size(w, h);
        let png = if tw != w || th != h {
            resize_png(&png, tw, th).unwrap_or(png)
        } else {
            png
        };
        let (fw, fh) = image_size(&png).unwrap_or((tw, th));
        let captured_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let scale = self.window.scale_factor();
        let obs = Observation {
            id: uuid::Uuid::new_v4().to_string(),
            session: self.status.session.clone(),
            generation: self.status.generation.clone(),
            tab_id: tab_id_s,
            url,
            title,
            transform: Transform {
                width: fw,
                height: fh,
                css_width: (fw as f64) / scale.max(0.01),
                css_height: (fh as f64) / scale.max(0.01),
            },
            viewport: Viewport {
                width: fw,
                height: fh,
                device_pixel_ratio: scale,
            },
            captured_ms,
            image_path: String::new(),
            capture_quality: quality.into(),
        };
        Ok((obs, png))
    }

    fn run_actions(&mut self, tab_id: Option<&str>, actions: &[Action]) -> Result<usize> {
        let mut completed = 0usize;
        for action in actions {
            if let Action::Wait {
                selector,
                url_contains,
                timeout_ms,
            } = action
            {
                let ms = timeout_ms.unwrap_or(5000);
                let deadline = std::time::Instant::now()
                    + std::time::Duration::from_millis(ms);
                let sel = selector.clone().unwrap_or_default();
                let urlc = url_contains.clone().unwrap_or_default();
                loop {
                    let expr = format!(
                        "(function(){{ const sel={sel:?}; const urlc={urlc:?}; \
                         if(sel && document.querySelector(sel)) return true; \
                         if(urlc && location.href.includes(urlc)) return true; \
                         return false; }})()"
                    );
                    let tab = self.tab_mut(tab_id)?;
                    let raw = capture::js_eval(&tab.webview, &expr).unwrap_or_else(|_| "false".into());
                    if raw.contains("true") {
                        break;
                    }
                    if std::time::Instant::now() > deadline {
                        bail!("wait timed out after {ms}ms");
                    }
                    capture::pump_brief();
                }
                completed += 1;
                continue;
            }
            let script = action_script(action)?;
            // Run as expression that returns true so js_eval confirms completion.
            let expr = format!("(function(){{ {script}; return true; }})()");
            {
                let tab = self.tab_mut(tab_id)?;
                let _ = capture::js_eval(&tab.webview, &expr).or_else(
                    |_| -> Result<String> {
                        tab.webview.evaluate_script(&script)?;
                        Ok("true".into())
                    },
                )?;
            }
            completed += 1;
            // Brief settle so layout/scroll finishes before the next act or observe.
            capture::pump_brief();
        }
        Ok(completed)
    }

    fn read_page(
        &mut self,
        tab_id: Option<&str>,
        mode: &str,
        selector: Option<&str>,
        max_chars: usize,
    ) -> Result<String> {
        let sel = selector.unwrap_or("body");
        let expression = match mode {
            "text" | "markdown" => format!(
                r#"(function(){{const el=document.querySelector({sel:?})||document.body; const t=(el&&el.innerText)||''; return t.slice(0,{max_chars});}})()"#
            ),
            "html" => format!(
                r#"(function(){{const el=document.querySelector({sel:?})||document.documentElement; const t=(el&&el.outerHTML)||''; return t.slice(0,{max_chars});}})()"#
            ),
            "query" => format!(
                r#"(function(){{const el=document.querySelector({sel:?}); if(!el) return {{found:false}}; return {{found:true,tag:el.tagName,text:(el.innerText||'').slice(0,500),value:el.value||null,href:el.href||null}};}})()"#
            ),
            "actions_inventory" => format!(
                r#"(function(){{const out=[]; document.querySelectorAll('a[href],button,input,textarea,select,[role=button]').forEach((el,i)=>{{if(i>=80)return; out.push({{tag:el.tagName,text:(el.innerText||el.value||'').trim().slice(0,80),href:el.href||null,type:el.type||null}});}}); return out;}})()"#
            ),
            other => bail!("unknown read mode {other}"),
        };
        let tab = self.tab_mut(tab_id)?;
        let raw = capture::js_eval(&tab.webview, &expression)?;
        // wry returns a JSON string; unwrap string literals for text modes.
        if matches!(mode, "text" | "markdown" | "html") {
            if let Ok(serde_json::Value::String(s)) = serde_json::from_str::<serde_json::Value>(&raw)
            {
                return Ok(s);
            }
        }
        Ok(raw)
    }

    pub fn clear_profile(&mut self) -> Result<()> {
        self.tabs.clear();
        self.active = None;
        // Best-effort wipe; new context requires rebuild — reopen blank tab.
        let _ = std::fs::remove_dir_all(&self.profile_dir);
        std::fs::create_dir_all(&self.profile_dir)?;
        self.open_tab(Some("about:blank".into()), true)?;
        Ok(())
    }
}

fn action_script(action: &Action) -> Result<String> {
    match action {
        Action::Click {
            selector,
            x,
            y,
            button,
        } => {
            let btn = match button {
                crate::app::runtime::screen_browser::ClickButton::Right => "contextmenu",
                crate::app::runtime::screen_browser::ClickButton::Double => "dblclick",
                _ => "click",
            };
            if let Some(sel) = selector {
                Ok(format!(
                    r#"(function(){{const el=document.querySelector({sel:?}); if(!el) throw new Error('not found'); el.scrollIntoView({{block:'center'}}); el.dispatchEvent(new MouseEvent('{btn}',{{bubbles:true,cancelable:true,view:window}})); if({btn:?}==='click'&&typeof el.click==='function') el.click();}})();"#
                ))
            } else {
                let x = x.ok_or_else(|| anyhow::anyhow!("click needs selector or x,y"))?;
                let y = y.ok_or_else(|| anyhow::anyhow!("click needs selector or x,y"))?;
                Ok(format!(
                    r#"(function(){{const el=document.elementFromPoint({x},{y}); if(!el) throw new Error('no element'); el.dispatchEvent(new MouseEvent('{btn}',{{bubbles:true,cancelable:true,clientX:{x},clientY:{y},view:window}}));}})();"#
                ))
            }
        }
        Action::Dblclick { selector, x, y } => action_script(&Action::Click {
            selector: selector.clone(),
            x: *x,
            y: *y,
            button: crate::app::runtime::screen_browser::ClickButton::Double,
        }),
        Action::Hover { selector, x, y } => {
            if let Some(sel) = selector {
                Ok(format!(
                    r#"(function(){{const el=document.querySelector({sel:?}); if(!el) throw new Error('not found'); el.dispatchEvent(new MouseEvent('mouseover',{{bubbles:true}})); el.dispatchEvent(new MouseEvent('mouseenter',{{bubbles:true}}));}})();"#
                ))
            } else {
                let x = x.unwrap_or(0.0);
                let y = y.unwrap_or(0.0);
                Ok(format!(
                    r#"(function(){{const el=document.elementFromPoint({x},{y}); if(el){{el.dispatchEvent(new MouseEvent('mouseover',{{bubbles:true,clientX:{x},clientY:{y}}}));}}}})();"#
                ))
            }
        }
        Action::Scroll {
            selector,
            delta,
            to,
            ..
        } => {
            if let Some(t) = to {
                Ok(format!(
                    r#"(function(){{const el=document.querySelector({t:?}); if(el) el.scrollIntoView({{block:'center'}});}})();"#
                ))
            } else if let Some(sel) = selector {
                let d = delta.unwrap_or(3);
                Ok(format!(
                    r#"(function(){{const el=document.querySelector({sel:?})||document.scrollingElement; el.scrollBy(0, {d}*40);}})();"#
                ))
            } else {
                let d = delta.unwrap_or(3);
                Ok(format!(
                    r#"(function(){{(document.scrollingElement||document.body).scrollBy(0,{d}*40);}})();"#
                ))
            }
        }
        Action::Type { text, selector } => {
            let t = text.replace('\\', "\\\\").replace('\'', "\\'");
            if let Some(sel) = selector {
                Ok(format!(
                    r#"(function(){{const el=document.querySelector({sel:?}); if(!el) throw new Error('not found'); el.focus(); el.value='{t}'; el.dispatchEvent(new Event('input',{{bubbles:true}})); el.dispatchEvent(new Event('change',{{bubbles:true}}));}})();"#
                ))
            } else {
                Ok(format!(
                    r#"(function(){{const el=document.activeElement; if(!el) throw new Error('no focus'); if('value' in el){{el.value=(el.value||'')+'{t}'; el.dispatchEvent(new Event('input',{{bubbles:true}}));}} else {{document.execCommand('insertText',false,'{t}');}}}})();"#
                ))
            }
        }
        Action::Key { keys } => {
            let key = keys.last().cloned().unwrap_or_default();
            Ok(format!(
                r#"(function(){{const el=document.activeElement||document.body; el.dispatchEvent(new KeyboardEvent('keydown',{{key:{key:?},bubbles:true}})); el.dispatchEvent(new KeyboardEvent('keyup',{{key:{key:?},bubbles:true}}));}})();"#
            ))
        }
        Action::Wait {
            selector,
            url_contains,
            timeout_ms,
        } => {
            // Poll in Rust, not a busy JS while-loop (that freezes the page).
            let ms = timeout_ms.unwrap_or(5000);
            let sel = selector.clone().unwrap_or_default();
            let urlc = url_contains.clone().unwrap_or_default();
            Ok(format!(
                "(function(){{ const sel={sel:?}; const urlc={urlc:?}; \
                 if(sel && document.querySelector(sel)) return true; \
                 if(urlc && location.href.includes(urlc)) return true; \
                 return false; /* host polls up to {ms}ms */ }})()"
            ))
        }
    }
}

fn image_size(png: &[u8]) -> Option<(u32, u32)> {
    let img = image::load_from_memory(png).ok()?;
    Some((img.width(), img.height()))
}

fn resize_png(png: &[u8], w: u32, h: u32) -> Result<Vec<u8>> {
    let img = image::load_from_memory(png)?.resize_exact(w, h, image::imageops::FilterType::Triangle);
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)?;
    Ok(out)
}

mod capture {
    //! Chrome-style **visible tab** screenshots of the page content webview
    //! (not koma chrome, not OS desktop). Plus a shared JS eval helper used by
    //! observe/read/eval/act verification across macOS / Windows / Linux.
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const WAIT: Duration = Duration::from_secs(5);

    /// Chrome-style visible-tab capture of the page content webview only.
    pub fn snapshot_tab(webview: &WebView, full_page: bool) -> Result<Vec<u8>> {
        #[cfg(target_os = "macos")]
        {
            return mac::snapshot_tab(webview, full_page);
        }
        #[cfg(target_os = "windows")]
        {
            let _ = full_page;
            return win::snapshot_tab(webview);
        }
        #[cfg(target_os = "linux")]
        {
            let _ = full_page;
            return linux::snapshot_tab(webview);
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = (webview, full_page);
            bail!("page screenshot unsupported on this OS")
        }
    }

    /// Fallback: OS capture of the content region under the chrome strip.
    pub fn snapshot_content_region(window: &Window, chrome_h_logical: f64) -> Result<Vec<u8>> {
        let scale = window.scale_factor();
        let outer = window
            .outer_position()
            .map_err(|e| anyhow::anyhow!("window position: {e}"))?;
        let size = window.inner_size();
        let chrome_px = (chrome_h_logical * scale).round() as i32;
        let x = outer.x;
        let y = outer.y + chrome_px;
        let w = size.width as i32;
        let h = (size.height as i32 - chrome_px).max(1);
        let path = std::env::temp_dir().join(format!("koma-sb-{}.png", uuid::Uuid::new_v4()));

        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            let status = Command::new("screencapture")
                .args([
                    "-x",
                    "-R",
                    &format!("{x},{y},{w},{h}"),
                    path.to_str().unwrap_or("/tmp/koma-sb.png"),
                ])
                .status()
                .context("screencapture")?;
            if !status.success() {
                bail!("screencapture failed");
            }
            let bytes = std::fs::read(&path)?;
            let _ = std::fs::remove_file(&path);
            if bytes.is_empty() {
                bail!("empty capture");
            }
            return Ok(bytes);
        }
        #[cfg(target_os = "linux")]
        {
            use std::process::Command;
            let p = path.to_string_lossy().to_string();
            let ok = Command::new("grim")
                .args(["-g", &format!("{x},{y} {w}x{h}"), &p])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
                || Command::new("import")
                    .args([
                        "-window",
                        "root",
                        "-crop",
                        &format!("{w}x{h}+{x}+{y}"),
                        &p,
                    ])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
            if !ok {
                bail!("no grim/import capture tool available");
            }
            let bytes = std::fs::read(&path)?;
            let _ = std::fs::remove_file(&path);
            return Ok(bytes);
        }
        #[cfg(target_os = "windows")]
        {
            let _ = (x, y, w, h, path);
            bail!("OS region capture not available; need WebView2 CapturePreview")
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = (window, chrome_h_logical, path);
            bail!("screenshot unsupported on this OS")
        }
    }

    /// Evaluate JS and return the JSON-serialized result (wry portable path).
    /// Used by read / eval so agents can get real page data on every OS.
    pub fn js_eval(webview: &WebView, expression: &str) -> Result<String> {
        let (tx, rx) = mpsc::channel::<String>();
        // wry serializes the completion value as JSON text.
        let js = format!(
            "(function(){{ try {{ return ({expression}); }} catch (e) {{ return {{__koma_err: String(e)}}; }} }})()"
        );
        webview.evaluate_script_with_callback(&js, move |value| {
            let _ = tx.send(value);
        })?;
        wait_recv(rx).map_err(|e| anyhow::anyhow!("js eval: {e}"))
    }

    fn wait_recv(rx: mpsc::Receiver<String>) -> Result<String, String> {
        let deadline = Instant::now() + WAIT;
        loop {
            match rx.try_recv() {
                Ok(v) => return Ok(v),
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("callback dropped".into());
                }
                Err(mpsc::TryRecvError::Empty) => {
                    if Instant::now() > deadline {
                        return Err("timed out".into());
                    }
                    pump_main_events();
                }
            }
        }
    }

    fn pump_main_events() {
        #[cfg(target_os = "macos")]
        {
            use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSRunLoop};
            let run_loop = NSRunLoop::currentRunLoop();
            let until = NSDate::dateWithTimeIntervalSinceNow(0.02);
            let _ = unsafe { run_loop.runMode_beforeDate(NSDefaultRunLoopMode, &until) };
            return;
        }
        #[cfg(target_os = "linux")]
        {
            // wry builds on gtk — drain pending events so JS callbacks fire.
            while gtk::events_pending() {
                let _ = gtk::main_iteration_do(false);
            }
            std::thread::sleep(Duration::from_millis(5));
            return;
        }
        #[cfg(target_os = "windows")]
        {
            // Pump the Win32 queue so WebView2 completion handlers run.
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
                };
                let mut msg: MSG = std::mem::zeroed();
                while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
            return;
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Short main-thread pump used between act steps.
    pub fn pump_brief() {
        for _ in 0..3 {
            pump_main_events();
        }
        std::thread::sleep(Duration::from_millis(30));
    }

    #[cfg(target_os = "macos")]
    mod mac {
        use super::*;
        use block2::RcBlock;
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSImage;
        use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSError, NSRunLoop};
        use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
        use std::cell::RefCell;
        use std::rc::Rc;
        use wry::WebViewExtMacOS;

        pub fn snapshot_tab(webview: &WebView, full_page: bool) -> Result<Vec<u8>> {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| anyhow::anyhow!("page screenshot must run on the GUI main thread"))?;
            let wk = webview.webview();
            let slot: Rc<RefCell<Option<Result<Vec<u8>, String>>>> =
                Rc::new(RefCell::new(None));
            let out = Rc::clone(&slot);

            let config = if full_page {
                // Visible bounds remain the Chrome captureVisibleTab default;
                // full_page still uses takeSnapshot (document may be clipped).
                Some(unsafe { WKSnapshotConfiguration::new(mtm) })
            } else {
                None
            };

            let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let res = if !error.is_null() {
                    Err("WKWebView takeSnapshot failed".into())
                } else if image.is_null() {
                    Err("WKWebView takeSnapshot returned no image".into())
                } else {
                    let img = unsafe { &*image };
                    nsimage_to_png(img).map_err(|e| e.to_string())
                };
                *out.borrow_mut() = Some(res);
            });

            unsafe {
                let as_wk: &WKWebView = &*wk;
                as_wk.takeSnapshotWithConfiguration_completionHandler(
                    config.as_deref(),
                    &block,
                );
            }

            let deadline = Instant::now() + WAIT;
            while slot.borrow().is_none() {
                if Instant::now() > deadline {
                    bail!("WKWebView takeSnapshot timed out");
                }
                let run_loop = NSRunLoop::currentRunLoop();
                let until = NSDate::dateWithTimeIntervalSinceNow(0.02);
                let _ = unsafe { run_loop.runMode_beforeDate(NSDefaultRunLoopMode, &until) };
            }

            let taken = slot.borrow_mut().take();
            match taken {
                Some(Ok(png)) if !png.is_empty() => Ok(png),
                Some(Ok(_)) => bail!("empty WKWebView snapshot"),
                Some(Err(e)) => bail!(e),
                None => bail!("WKWebView takeSnapshot produced no result"),
            }
        }

        fn nsimage_to_png(image: &NSImage) -> Result<Vec<u8>> {
            // TIFF → image crate → PNG (avoids NSBitmapImageRep feature maze).
            let tiff = image
                .TIFFRepresentation()
                .ok_or_else(|| anyhow::anyhow!("NSImage has no TIFF representation"))?;
            let bytes = tiff.to_vec();
            let img = image::load_from_memory(&bytes)
                .context("decode WKWebView TIFF snapshot")?;
            let mut out = Vec::new();
            img.write_to(
                &mut std::io::Cursor::new(&mut out),
                image::ImageFormat::Png,
            )?;
            Ok(out)
        }
    }

    #[cfg(target_os = "windows")]
    mod win {
        use super::*;
        use std::fs;
        use std::sync::{Arc, Mutex};
        use wry::WebViewExtWindows;

        pub fn snapshot_tab(webview: &WebView) -> Result<Vec<u8>> {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            };
            use webview2_com::CapturePreviewCompletedHandler;
            use windows::core::{Interface, PCWSTR};
            use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;
            use windows::Win32::System::Com::{
                IStream, STGM_CREATE, STGM_READWRITE, STGM_SHARE_EXCLUSIVE,
            };

            let controller = webview.controller();
            let core: ICoreWebView2 = unsafe { controller.CoreWebView2() }
                .map_err(|e| anyhow::anyhow!("CoreWebView2: {e}"))?;

            let path = std::env::temp_dir().join(format!("koma-sb-{}.png", uuid::Uuid::new_v4()));
            let wide: Vec<u16> = path
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();

            let stream: IStream = unsafe {
                SHCreateStreamOnFileEx(
                    PCWSTR(wide.as_ptr()),
                    STGM_CREATE.0 | STGM_READWRITE.0 | STGM_SHARE_EXCLUSIVE.0,
                    0,
                    true,
                    None,
                )
            }
            .map_err(|e| anyhow::anyhow!("SHCreateStreamOnFileEx: {e}"))?;

            let done = Arc::new(Mutex::new(None::<Result<(), String>>));
            let flag = Arc::clone(&done);
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |err| {
                let res = if err.is_ok() {
                    Ok(())
                } else {
                    Err(format!("CapturePreview failed: {err:?}"))
                };
                *flag.lock().unwrap_or_else(|e| e.into_inner()) = Some(res);
                Ok(())
            }));

            unsafe {
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &handler,
                )
            }
            .map_err(|e| anyhow::anyhow!("CapturePreview: {e}"))?;

            let deadline = Instant::now() + WAIT;
            loop {
                if let Some(res) = done.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    res.map_err(|e| anyhow::anyhow!(e))?;
                    break;
                }
                if Instant::now() > deadline {
                    bail!("WebView2 CapturePreview timed out");
                }
                super::pump_main_events();
            }

            let _ = unsafe { stream.Commit(0) };
            let bytes = fs::read(&path)?;
            let _ = fs::remove_file(&path);
            if bytes.is_empty() {
                bail!("empty WebView2 capture");
            }
            Ok(bytes)
        }
    }

    #[cfg(target_os = "linux")]
    mod linux {
        use super::*;
        use wry::WebViewExtUnix;

        pub fn snapshot_tab(webview: &WebView) -> Result<Vec<u8>> {
            use gtk::gdk::Texture;
            use gtk::prelude::*;
            use webkit2gtk::WebViewExt;

            let wk = webview.webview();
            let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();

            // webkit2gtk 2.40+: snapshot of the visible viewport (Chrome-like).
            wk.snapshot(
                webkit2gtk::SnapshotRegion::Visible,
                webkit2gtk::SnapshotOptions::NONE,
                None::<&gtk::gio::Cancellable>,
                move |res| {
                    let out = match res {
                        Ok(texture) => texture_to_png(&texture),
                        Err(e) => Err(format!("webkit snapshot: {e}")),
                    };
                    let _ = tx.send(out);
                },
            );

            let deadline = Instant::now() + WAIT;
            loop {
                match rx.try_recv() {
                    Ok(Ok(png)) if !png.is_empty() => return Ok(png),
                    Ok(Ok(_)) => bail!("empty webkit snapshot"),
                    Ok(Err(e)) => bail!(e),
                    Err(mpsc::TryRecvError::Disconnected) => {
                        bail!("webkit snapshot callback dropped")
                    }
                    Err(mpsc::TryRecvError::Empty) => {
                        if Instant::now() > deadline {
                            bail!("webkit snapshot timed out");
                        }
                        super::pump_main_events();
                    }
                }
            }
        }

        fn texture_to_png(texture: &gtk::gdk::Texture) -> Result<Vec<u8>, String> {
            // Save via gdk texture PNG bytes when available; else downcast path.
            let w = texture.width();
            let h = texture.height();
            if w <= 0 || h <= 0 {
                return Err("empty texture".into());
            }
            // gdk::Texture has save_to_png_bytes on newer gtk4; webkit2gtk may be gtk3.
            // Use MemoryTexture download if possible.
            #[allow(unused_imports)]
            use gtk::gdk::prelude::TextureExt;
            let bytes = texture.save_to_png_bytes();
            Ok(bytes.to_vec())
        }
    }
}
