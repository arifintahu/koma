/** Colour roles shared with `view/theme.rs`. Only `dark` is filled in. */

export interface Theme {
  /** Palette name the daemon asked for. Colours may still be the dark set. */
  name: string
  bg: string
  fg: string
  dim: string
  accent: string
  panel: string
  selFg: string
  selBg: string
  success: string
  warn: string
  error: string
  info: string
  heat: [string, string, string, string, string]
}

/** Names the daemon may send. Filling any of these later is a table, not a rewrite. */
export const PALETTE_NAMES = [
  "dark",
  "light",
  "forest",
  "autumn",
  "warm",
  "cold symphony",
  "winter",
  "monokai",
  "vscode",
  "github dark",
] as const

const DARK: Omit<Theme, "name"> = {
  bg: "#000000",
  fg: "#e6e6e6",
  dim: "#adadad",
  accent: "#39ff14",
  panel: "#2b2f38",
  selFg: "#000000",
  selBg: "#39ff14",
  success: "#00c853",
  warn: "#ffb43c",
  error: "#ff3c3c",
  info: "#50c8ff",
  heat: ["#232323", "#00783c", "#64a032", "#c88c00", "#dc3232"],
}

/** Resolve a snapshot palette name. Unknown names, and every name except the
 * filled `dark` values, paint with `dark` while keeping the requested name. */
export function themeFor(name: string | null | undefined): Theme {
  const requested = name && name.trim().length > 0 ? name : "dark"
  return { name: requested, ...DARK }
}
