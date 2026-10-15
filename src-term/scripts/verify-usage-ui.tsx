/** Actual SessionScreen input against an isolated daemon and real usage worker.
 * Build Rust first; run from the repo root with src-term/.tools/bun.
 */
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { Database } from "bun:sqlite"
import { act, useMemo } from "react"
import { useRenderer } from "@opentui/react"
import { SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { SessionScreen } from "../src/session.tsx"
import { LocalUsageLane, type UsageRequest } from "../src/usage-reader.ts"
import { FrameReader, fold, encodeFrame, decodeFrames, type Snapshot } from "../src/protocol.ts"
import type { DaemonTransport } from "../src/transport.ts"
import { syntaxStyles } from "../src/syntax.ts"
import { themeFor } from "../src/theme.ts"
const root = resolve(import.meta.dir, "../.."), data = mkdtempSync("/private/tmp/koma-usage-ui-")
const id = crypto.randomUUID(), frames: string[] = [], reads: UsageRequest[] = []
const previous = process.env.KOMA_TEST_DATA_DIR
process.env.KOMA_TEST_DATA_DIR = data
writeFileSync(`${data}/config.json`, JSON.stringify({ providers: [{ uuid: "offline", name: "Offline", endpoint: "http://127.0.0.1:9/v1", api_key: "test" }], models: [{ uuid: "model", name: "Offline", model_id: "offline", provider_uuid: "offline", roles: ["main"] }] }))
const db = new Database(`${data}/usage.sqlite`)
db.exec("CREATE TABLE usage(id INTEGER PRIMARY KEY,ts INTEGER,model_id TEXT,role TEXT,session_uuid TEXT,pwd_hash TEXT,tokens_in INTEGER,tokens_cached INTEGER,tokens_out INTEGER,cost REAL)")
for (let i = 0; i < 13; i++) db.query("INSERT INTO usage(ts,model_id,role,session_uuid,tokens_in,tokens_cached,tokens_out,cost) VALUES(?,?,?,?,100,30,20,1)").run(Math.floor(Date.now()/1000), `fixture-model-${i}`, "main", id)
db.close()
const daemon = Bun.spawn([`${root}/target/debug/koma`, "--daemon", "--session", id], { cwd: root, env: { ...process.env }, stdout: "ignore", stderr: "pipe" })
/** Loopback adapter bypasses normal launcher discovery. Its reader is a real
 * local worker; remote-host isolation is separately tested by verify-remote.py. */
class Loopback implements DaemonTransport {
  readonly remote = true
  private lane = new LocalUsageLane()
  usage = { request: (r: UsageRequest) => { reads.push(r); return this.lane.request(r) }, dispose: () => this.lane.dispose() }
  socket: Awaited<ReturnType<typeof Bun.connect>> | null = null
  snap: Snapshot | null = null
  reader = new FrameReader()
  outgoing: any[] = []
  pending = new Set<string>()
  async open(_id: string, receive: (b: Uint8Array) => void, close: () => void, error: (e: unknown) => void) {
    const deadline = Date.now() + 15000
    while (true) {
      try {
        this.socket = await Bun.connect({ unix: `${data}/run/${id}.sock`, socket: { data: (_s, bytes) => {
          for (const envelope of this.reader.push(bytes) as { event: any }[]) {
            this.snap = fold(this.snap, envelope.event)
            if (envelope.event?.MenuResult) { assert(!envelope.event.MenuResult.error, envelope.event.MenuResult.error); this.pending.delete(envelope.event.MenuResult.request_id) }
          }
          receive(bytes)
        }, close, error: (_s, e) => error(e) } })
        return
      } catch (e) { if (Date.now() > deadline) throw e; await Bun.sleep(25) }
    }
  }
  write(bytes: Uint8Array) { for (const r of decodeFrames(bytes) as any[]) { this.outgoing.push(r); if (r.Menu) this.pending.add(r.Menu.request_id) } return this.socket?.write(bytes) ?? 0 }
  send(request: unknown) { this.write(encodeFrame(request)) }
  end() { this.socket?.end() }
}
const transport = new Loopback()
function Screen() {
  const renderer = useRenderer(), style = useMemo(() => SyntaxStyle.fromStyles(syntaxStyles(themeFor("dark")), renderer.nativeScene), [renderer])
  return <SessionScreen id={id} transport={transport} syntaxStyle={style} onHome={()=>{}} onOpen={()=>{}} onExit={()=>{}} onRemote={()=>{}} onPalette={()=>{}} />
}
const view = await testRender(<Screen />, { width: 100, height: 40 })
const usage = () => (transport.snap?.global.mode as any)?.Usage
async function settle(predicate: () => unknown = () => true) {
  const deadline = Date.now() + 10000
  do { await act(async () => { await Bun.sleep(25); await view.waitForVisualIdle() }); if (predicate()) return } while (Date.now() < deadline)
  throw Error(`Timed out\n${view.captureCharFrame()}`)
}
async function press(key: string) { await act(async () => { view.mockInput.pressKey(key) }); await settle(() => transport.pending.size === 0) }
async function click(label: string) {
  const lines = view.captureCharFrame().split("\n"), y = lines.findIndex(l => l.includes(label))
  assert(y >= 0, `${label} missing`)
  await act(async () => { await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y) }); await settle(() => transport.pending.size === 0)
}
try {
  await settle(() => transport.snap?.global.mode === "Chat")
  if (view.captureCharFrame().includes("[x]")) await click("[x]")
  transport.send({ ReplaceInput: { text: "/usage", cursor: 6 } }); transport.send({ SendKey: { code: "Enter", mods: 0 } })
  await settle(() => usage() && view.captureCharFrame().includes("$13.0000"))
  assert(transport.outgoing.some(r => r.SetUsageReader?.enabled))
  assert.equal(usage().data.top_models.length, 0)
  const sent = transport.outgoing.length, before = view.captureCharFrame().split("\n").find(l => l.includes(" – "))
  await press("ARROW_LEFT")
  assert.notEqual(view.captureCharFrame().split("\n").find(l => l.includes(" – ")), before)
  assert.equal(transport.outgoing.length, sent, "chart arrows must stay local")
  await press("m"); await settle(() => usage()?.metric === "tokens")
  for (const [scope, range, key] of [["global", "today", "1"], ["global", "week", "2"], ["global", "year", "3"], ["session", "year", "TAB"]]) {
    await press(key!); await settle(() => usage()?.view === scope && (scope === "session" || usage()?.range === range))
    await settle(() => reads.at(-1)?.scope === scope && view.captureCharFrame().includes("$13.0000"))
    for (const [width, height] of [[50, 24], [80, 18], [100, 40], [160, 45]]) {
      await act(async () => { view.resize(width!, height!) }); await settle()
      const frame = view.captureCharFrame(); assert(frame.includes("Summary")); assert(frame.includes("esc back")); assert(frame.includes("Retry"))
      frames.push(`${scope}/${range} ${width}×${height}\n${frame}`)
    }
  }
  for (let i = 0; i < 20; i++) await press("\u001b[6~")
  assert(view.captureCharFrame().includes("fixture-model-12"))
  transport.send({ ReplaceInput: { text: "retained draft", cursor: 14 } })
  await press("ESCAPE"); await settle(() => transport.snap?.global.mode === "Chat")
  assert.equal(transport.snap?.global.input, "retained draft")
  const paused = reads.length; await act(async () => { await Bun.sleep(1100) }); assert.equal(reads.length, paused)
  writeFileSync("/tmp/koma-usage-live-frames.txt", frames.join("\n\n"))
  console.log("PASS: real SessionScreen reader negotiation, local arrows, metric/range/scope keys, all views/sizes, complete models, Esc/draft restoration, and polling pause")
} finally {
  await act(async () => { await view.dispose() }); transport.usage.dispose(); transport.end(); daemon.kill(); await daemon.exited
  if (previous == null) delete process.env.KOMA_TEST_DATA_DIR; else process.env.KOMA_TEST_DATA_DIR = previous
  rmSync(data, { recursive: true, force: true })
}
