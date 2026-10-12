export type ScreenBrowserTab = {
  id: string
  title: string
  url: string
  active: boolean
  loading: boolean
  favicon?: string
  error?: string
}

export type ScreenBrowserCapabilities = {
  tabs: boolean
  capture: boolean
  input: boolean
  eval: boolean
  downloads: boolean
  floating: boolean
  limitations: string[]
}

export type ScreenBrowserBlockedNav = {
  url: string
  key: string
  label: string
  tab_id?: string | null
  can_allow: boolean
}

export type ScreenBrowserPrefs = {
  always_on_top: boolean
  auto_screenshot: boolean
  stop_on_close: boolean
  allow_eval: boolean
  download_dir?: string | null
  popup_policy: string
  allowed_nav?: string[]
}

export type ScreenBrowserObservation = {
  id: string
  url: string
  title: string
  image_path: string
  tab_id: string
  captured_ms?: number
  width?: number
  height?: number
  capture_quality?: string
}

export type ScreenBrowserStatus = {
  session: string
  generation: string
  enabled: boolean
  paused: boolean
  busy: boolean
  waiting_human: boolean
  window_open: boolean
  always_on_top: boolean
  capabilities: ScreenBrowserCapabilities
  prefs: ScreenBrowserPrefs
  tabs: ScreenBrowserTab[]
  active_tab?: string | null
  observation?: ScreenBrowserObservation | null
  message: string
  waiting_message?: string | null
  blocked_nav?: ScreenBrowserBlockedNav | null
}

export const DEFAULT_SCREEN_BROWSER_PREFS: ScreenBrowserPrefs = {
  always_on_top: false,
  auto_screenshot: true,
  // Window X matches the titlebar Stop control (no silent re-spawn).
  stop_on_close: true,
  allow_eval: false,
  download_dir: null,
  popup_policy: 'new_tab',
}
