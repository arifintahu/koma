import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8"

export interface LiveSession {
  session_id: string
  name: string
  pwd: string
  working: boolean
  is_foreground?: boolean
}

export interface HistorySession {
  session_id: string
  name: string
  pwd: string
  updated_at: number
  dir_label: string
}

export interface SessionsFile {
  live: LiveSession[]
  history: HistorySession[]
}

/** Palette saved in the data directory. The hub stays dark; a session uses this before its snapshot arrives. */
export function savedPalette(): string {
  const override = process.env.KOMA_TEST_DATA_DIR
  const dir = override && override.length > 0 ? override : join(homedir(), ".koma")
  try {
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { palette?: unknown }
    return typeof raw.palette === "string" && raw.palette.trim() ? raw.palette : "dark"
  } catch {
    return "dark"
  }
}

export function launchPalette(kind: "hub" | "session" | "remote", saved: string): string {
  return kind === "hub" ? "dark" : saved || "dark"
}

export function komaBin(): string {
  const fromEnv = process.env.KOMA_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const here = fileURLToPath(new URL(".", import.meta.url))
  const debug = join(here, "../../target/debug/koma")
  if (existsSync(debug)) return debug
  return fromEnv && fromEnv.length > 0 ? fromEnv : "koma"
}

export function socketPath(sessionId: string): string {
  return join(homedir(), ".koma", "run", `${sessionId}.sock`)
}

/** UUID v5, simple hex, matching Rust `Uuid::new_v5(...).simple()`. */
export function uuidV5Simple(namespaceUuid: string, name: string): string {
  const namespace = Buffer.from(namespaceUuid.replace(/-/g, ""), "hex")
  const digest = createHash("sha1").update(namespace).update(name, "utf8").digest()
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
  return digest.subarray(0, 16).toString("hex")
}

/** `~/.koma/sessions/<pwd_hash>/<id>`, the same bucket `model::store::pwd_hash` uses. */
export function sessionDir(cwd: string, sessionId: string): string {
  let path = cwd
  try {
    path = realpathSync(cwd)
  } catch {
    // Missing dirs hash as given, same as the daemon.
  }
  return join(homedir(), ".koma", "sessions", uuidV5Simple(NAMESPACE_OID, path), sessionId)
}

export function attachmentFile(cwd: string, sessionId: string, relPath: string): string {
  return join(sessionDir(cwd, sessionId), relPath)
}

export async function listSessions(): Promise<SessionsFile> {
  const proc = Bun.spawn([komaBin(), "sessions", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(err.trim() || `koma sessions --json exited ${code}`)
  }
  const trimmed = text.trim()
  if (!trimmed) return { live: [], history: [] }
  const parsed = JSON.parse(trimmed) as unknown
  if (Array.isArray(parsed)) return { live: parsed as LiveSession[], history: [] }
  const body = parsed as Partial<SessionsFile>
  return {
    live: Array.isArray(body.live) ? body.live : [],
    history: Array.isArray(body.history) ? body.history : [],
  }
}

export async function killSession(sessionId: string): Promise<void> {
  const proc = Bun.spawn([komaBin(), "daemon", "kill", "--session", sessionId], {
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
  })
  await proc.exited
}

export async function deleteSession(sessionId: string): Promise<void> {
  const proc = Bun.spawn([komaBin(), "daemon", "delete", "--session", sessionId], {
    stdout: "ignore",
    stderr: "pipe",
    stdin: "ignore",
  })
  await proc.exited
}

/** Start `koma --daemon --session <id>` in its own session so Ctrl-C stays with the UI. */
export function spawnDaemon(sessionId: string): void {
  const child = spawn(komaBin(), ["--daemon", "--session", sessionId], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
  })
  child.unref()
}

export async function ensureDaemon(sessionId: string): Promise<void> {
  const path = socketPath(sessionId)
  if (await probeSocket(path)) return
  // The daemon unlinks a stale socket itself before it binds.
  spawnDaemon(sessionId)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await probeSocket(path)) return
    await Bun.sleep(100)
  }
  throw new Error(`session daemon did not accept on ${path}`)
}

async function probeSocket(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  try {
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    })
    socket.end()
    return true
  } catch {
    return false
  }
}
