import { expect, test } from "bun:test"
import { scrollbars, themeFor } from "./theme.ts"

test("the scrollbar follows the active palette", () => {
  const dark = scrollbars(themeFor("dark"))
  const light = scrollbars(themeFor("light"))
  expect(dark.trackOptions.backgroundColor).toBe(themeFor("dark").panel)
  expect(dark.trackOptions.foregroundColor).toBe(themeFor("dark").dim)
  expect(light.trackOptions.backgroundColor).not.toBe(dark.trackOptions.backgroundColor)
  expect(light.trackOptions.foregroundColor).toBe(themeFor("light").dim)
})
