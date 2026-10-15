export type Rec = Record<string, unknown>

export function rec(value: unknown): Rec {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Rec
  return {}
}

export function str(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function flag(value: unknown): boolean {
  return value === true
}

export function rows(value: unknown): Rec[] {
  if (!Array.isArray(value)) return []
  return value.filter((row) => row && typeof row === "object") as Rec[]
}

export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((row) => str(row))
}

export function modeParts(mode: unknown): { name: string; body: Rec } | null {
  if (!mode || typeof mode !== "object" || Array.isArray(mode)) return null
  const record = mode as Rec
  const name = Object.keys(record)[0]
  if (!name) return null
  return { name, body: rec(record[name]) }
}

export function onOff(value: unknown): string {
  return flag(value) ? "on" : "off"
}

export function join(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "—"
  return value.map((row) => str(row)).join(", ")
}

export function clip(value: string, max = 72): string {
  const one = value.replace(/\s+/g, " ").trim()
  if (one.length <= max) return one
  return `${one.slice(0, max - 1)}…`
}
