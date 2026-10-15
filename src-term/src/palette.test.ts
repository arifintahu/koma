import { describe, expect, test } from "bun:test"
import { PALETTE_VISIBLE, commandSuggestions, commandSuggestionOffset, paletteWindow } from "./palette.ts"

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

test("hidden /select suggestions preserve command indices and direct execution", () => {
  const commands = ["/settings", "/select", "/help"].map((name) => ({ name, desc: name }))
  const visible = commandSuggestions(commands, 2)
  expect(visible.rows.map((row) => row.name)).toEqual(["/settings", "/help"])
  expect(visible.rows[visible.selected]?.sourceIndex).toBe(2)
  expect(commandSuggestionOffset(commands, 0, 1)).toBe(2)
  expect(commandSuggestionOffset(commands, 2, -1)).toBe(-2)
  expect(commandSuggestionOffset(commands, 0, -1)).toBe(0)
  expect(commandSuggestionOffset(commands, 2, 1)).toBe(0)
  expect(commandSuggestionOffset(commands, 1, 0)).toBe(1)
  // With /select typed directly, Enter still reaches its daemon handler.
  expect(commandSuggestions([commands[1]!], 0).rows).toEqual([])
  expect(commandSuggestionOffset([commands[1]!], 0, 0)).toBe(0)
})
