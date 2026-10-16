import { strict as assert } from "node:assert"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { addDefaultParsers } from "@opentui/core"
import { syntaxClient } from "./syntax.ts"

const timeout = setTimeout(() => { console.error("terminal self-test timed out"); process.exit(1) }, 30000)
const assets = new URL("assets/", import.meta.resolve("@opentui/core"))
const samples: Record<string, string> = {
  javascript: "const value = 42", typescript: "const value: number = 42",
  typescriptreact: "const value = <div>hello</div>", zig: "const value: u32 = 42;",
  markdown: "# Heading\n\n**hello**", markdown_inline: "**hello**",
  python: "def hello():\n    return 42", rust: "fn main() { let value = 42; }",
}
try {
  assert.equal(Bun.version, "1.4.3")
  // Every grammar and query shipped by OpenTUI must load in the real worker.
  for (const language of readdirSync(assets)) {
    const dir = new URL(`${language}/`, assets)
    const names = readdirSync(dir)
    const wasm = names.find(name => name.endsWith(".wasm"))
    if (!wasm) continue
    const queries = names.filter(name => name.endsWith(".scm"))
    assert(queries.includes("highlights.scm"))
    for (const query of queries) assert(readFileSync(new URL(query, dir)).length > 0)
    addDefaultParsers([{ filetype: language, wasm: fileURLToPath(new URL(wasm, dir)), queries: {
      highlights: [fileURLToPath(new URL("highlights.scm", dir))],
      ...(queries.includes("injections.scm") ? { injections: [fileURLToPath(new URL("injections.scm", dir))] } : {}),
    } }])
  }
  globalThis.fetch = (() => { throw new Error("self-test forbids network") }) as unknown as typeof fetch
  await syntaxClient.initialize()
  for (const [language, source] of Object.entries(samples)) {
    const result = await syntaxClient.highlightOnce(source, language)
    assert(!result.error, `${language}: ${result.error}`)
    assert(result.highlights?.length, `${language}: no native parser highlights`)
  }
  const view = await testRender(<box><text>offline native rendering</text></box>, { width: 80, height: 24 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    assert(view.captureCharFrame().includes("offline native rendering"))
    view.resize(50, 18)
    await act(async () => { await view.waitForVisualIdle() })
    assert(view.captureCharFrame().includes("offline native rendering"))
  } finally { await act(async () => { await view.dispose() }) }
  console.log("Terminal payload verified: Bun, native rendering, worker, all shipped grammars and queries")
} finally {
  await syntaxClient.destroy()
  clearTimeout(timeout)
}
