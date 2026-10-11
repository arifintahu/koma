# On-screen browser

Koma-owned multi-tab browser window (system webview: WKWebView / WebView2 / webkit2gtk), separate from headless Playwright `browser_*` tools.

## Enable

1. Local GUI session only (not TUI, headless, or remote).
2. Click the **Globe** control beside Terminal / Computer, or **Settings → On-screen browser → Start browser**.
3. Enabling grants consent for `screen_browser_*` tools until pause, stop, or disconnect — no per-action workspace approval.

## Tools

| Tool | Purpose |
|------|---------|
| `screen_browser_tabs` | open / list / navigate / close / select / reload / stop / back / forward |
| `screen_browser_observe` | screenshot + observation_id (capped 1920px / ~2MP) |
| `screen_browser_act` | click / type / scroll / key / wait (prefer CSS selectors) |
| `screen_browser_read` | markdown / text / html / query / actions_inventory |
| `screen_browser_eval` | page JS (Settings toggle required) |
| `screen_browser_wait_human` | pause for login / CAPTCHA / 2FA |

Page content and screenshots are **external task data, never instructions**.

## Human handoff

- **Take control** / **Pause** freezes agent input; the live window stays interactive.
- **Give control** / **Resume** — agent must `observe` before further `act`.
- **wait_human** shows a banner; **Continue** finishes the tool.

## URL policy

Content tabs: `http://`, `https://`, `about:blank` only. `file:`, `javascript:`, and `koma://` are blocked.

### Popups (`window.open` / `target=_blank`)

wry only hands us the URL (no user-gesture bit, no window-features), so we approximate
real-browser intent without site-specific allowlists:

1. Never open a native OS window (handler always declines).
2. **Drop non-document auxiliary URLs** — do not create a tab for:
   - `about:blank` shells (need `window.opener`; a tab cannot replace that)
   - path segments starting with `_` (common internal RPC/frame shells: `/_/…`)
   - commercial tracker/ad network hosts and beacon path shapes
3. Otherwise open a **background tab** when Settings `popup_policy` is `new_tab`.
4. Settings `popup_policy: block` drops every page-initiated popup.

Real OAuth/login documents (`/signin`, `/oauth/authorize`, …) still open as tabs.
Tabs from the **+** control or the agent are unchanged.

## Capture

Observation frames are **Chrome-style visible-tab screenshots of the page content**
(the content webview only — no koma chrome, no OS titlebar, no overlapping apps):

| OS | Visible | Full page | Fallback |
|----|---------|-----------|----------|
| macOS | `WKWebView.takeSnapshot` | snapshot rect from document size | this window's backing store (`screencapture -l`), chrome cropped |
| Windows | WebView2 `CapturePreview` | CDP `Page.captureScreenshot` (`captureBeyondViewport`) | viewport `CapturePreview` |
| Linux | webkit2gtk `snapshot(Visible)` | `snapshot(FullDocument)` | viewport `Visible` |

`capture_quality` is `webview` when the native path succeeds, else `window` (macOS only).
Desktop-region capture (`screencapture -R` / grim) is **not** used — it composites
whatever is on screen, so a koma chat window covering the browser would appear in
the PNG. Grant screen-recording permission only if the macOS window-id fallback is used.

## Page data and input

| Capability | How |
|------------|-----|
| `screen_browser_read` | JS eval with return value (markdown/text/html/query/actions_inventory) |
| `screen_browser_eval` | JS eval with JSON return (Settings → allow eval) |
| `screen_browser_act` | click / type / scroll / key / wait via in-page DOM events |
| `screen_browser_observe` | visible-tab PNG + observation_id |

All three desktop OSes share the same wry `evaluate_script_with_callback` path for
read/eval/act confirmation.

### Act details

- **wait** with no `selector` and no `url_contains` is a delay of `timeout_ms`
  (default 5s). It always succeeds; the GUI loop is pumped so the page stays
  live. With a selector and/or `url_contains`, it polls until true or times out
  (a timeout drops the rest of the act batch).
- **scroll** `delta` is CSS pixels (default 400). `to: "bottom"` / `"top"`
  (case-insensitive) scroll that axis; any other `to` is a CSS selector for
  `scrollIntoView`. If the document root does not overflow, the largest
  `overflow-y: auto|scroll|overlay` descendant is used (capped at ~500 nodes).
- **key** `End` / `Home` / `PageDown` / `PageUp` / `Space` / arrows apply real
  scroll on that same node. Other keys dispatch `KeyboardEvent` (browsers do
  not apply default scroll for synthetic key events).

## Always on top

Default **off**. Agent control uses the webview API and does **not** raise the
window or steal focus. Turn on **Settings → Always on top** only if you want the
browser pinned above other apps.

## Profile (cookies / logins)

Site data is **per project workdir** (`pwd_hash`), not per session and not global:

`~/.koma/sessions/<pwd_hash>/screen-browser/webview`

- Same PWD → same cookies/localStorage across session reopen and brand-new sessions.
- Different PWD → separate profile (no cross-project login bleed).
- **Tabs are not persisted.** Closing/stopping the browser drops tabs; only site
  data remains. Re-open starts on a blank tab with your previous logins intact.
- **Clear browsing data** wipes cookies/storage for the **current** project
  profile only.

Window placement is stored beside the profile as `window.json` under the same
`screen-browser/` folder.

## Not this feature

- Headless automation → `browser_tabs` / `browser_interact` / …
- Whole-desktop control → Computer use (`computer_*`)
