import { expect, test } from "bun:test"
import { statusLabel, statusLooksLive } from "./chat.tsx"

test("a turn error stays off the status line", () => {
  expect(statusLabel("error: stream ended incompletely (connection closed before terminal marker)")).toBe("ready")
  expect(statusLabel("  Error: save failed")).toBe("ready")
})

test("an interrupted turn is not still running", () => {
  expect(statusLooksLive("interrupted")).toBe(false)
  expect(statusLooksLive("thinking")).toBe(true)
  expect(statusLabel("interrupted")).toBe("interrupted")
})

test("phase words and slash notices stay on the status line", () => {
  expect(statusLabel("ready")).toBe("ready")
  expect(statusLabel("thinking")).toBe("thinking")
  expect(statusLabel("retrying 1/3…")).toBe("retrying 1/3…")
  expect(statusLabel("usage: /rename <name>")).toBe("usage: /rename <name>")
  expect(statusLabel("approve tool? [y/n]")).toBe("approve tool? [y/n]")
})
