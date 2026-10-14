import { describe, expect, test } from "bun:test"
import { PALETTE_VISIBLE, paletteWindow } from "./palette.ts"

describe("palette window", () => {
  test("the highlight walks the eight rows before the window moves", () => {
    let start = 0
    for (let selected = 0; selected < PALETTE_VISIBLE; selected++) {
      start = paletteWindow(start, selected, 20)
      expect(start).toBe(0)
    }
    start = paletteWindow(start, PALETTE_VISIBLE, 20)
    expect(start).toBe(1)
    start = paletteWindow(start, PALETTE_VISIBLE - 1, 20)
    expect(start).toBe(1)
  })

  test("the window pushes up only when the highlight hits the top", () => {
    let start = paletteWindow(0, 8, 20)
    expect(start).toBe(1)
    start = paletteWindow(start, 1, 20)
    expect(start).toBe(1)
    start = paletteWindow(start, 0, 20)
    expect(start).toBe(0)
  })
})
