import { expect, test } from "bun:test"
import { fitAside } from "./bits.tsx"

test("a hub title stops before the right-hand info", () => {
  expect(fitAside("Short", "tmp · abcdef12  ready", 40)).toBe("Short")
  expect(fitAside("A very long session name", "ready", 12)).toBe("A ver…")
  expect(fitAside("Session", "", 4)).toBe("Ses…")
})
