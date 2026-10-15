import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { launchPalette, savedPalette } from "./paths.ts"
import { scrollbars, themeFor } from "./theme.ts"

test("the scrollbar follows the active palette", () => {
  const dark = scrollbars(themeFor("dark"))
  const light = scrollbars(themeFor("light"))
  expect(dark.trackOptions.backgroundColor).toBe(themeFor("dark").panel)
  expect(dark.trackOptions.foregroundColor).toBe(themeFor("dark").dim)
  expect(light.trackOptions.backgroundColor).not.toBe(dark.trackOptions.backgroundColor)
  expect(light.trackOptions.foregroundColor).toBe(themeFor("light").dim)
})

test("the hub stays dark and a session splash uses the saved palette", () => {
  const dir = mkdtempSync(join(tmpdir(), "koma-palette-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ palette: "light" }))
  const previous = process.env.KOMA_TEST_DATA_DIR
  process.env.KOMA_TEST_DATA_DIR = dir
  try {
    expect(savedPalette()).toBe("light")
    expect(launchPalette("hub", savedPalette())).toBe("dark")
    expect(launchPalette("session", savedPalette())).toBe("light")
    expect(launchPalette("remote", savedPalette())).toBe("light")
    expect(launchPalette("session", "")).toBe("dark")
  } finally {
    if (previous == null) delete process.env.KOMA_TEST_DATA_DIR
    else process.env.KOMA_TEST_DATA_DIR = previous
  }
})
