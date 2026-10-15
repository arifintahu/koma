import { expect, test } from "bun:test"
import { forwardKey } from "./keys.ts"

test("menu inputs preserve API-key case, punctuation, spaces, and Unicode", () => {
  expect(forwardKey({ name: "a", shift: true, sequence: "A" })).toEqual({ code: { Char: "A" }, mods: 1 })
  expect(forwardKey({ name: "_", shift: true, sequence: "_" })).toEqual({ code: { Char: "_" }, mods: 1 })
  expect(forwardKey({ name: "space", sequence: " " })).toEqual({ code: { Char: " " }, mods: 0 })
  expect(forwardKey({ name: "😀", sequence: "😀" })).toEqual({ code: { Char: "😀" }, mods: 0 })
})

test("ctrl+x is a control character, not a quit", () => {
  expect(forwardKey({ name: "x", ctrl: true })).toEqual({ code: { Char: "x" }, mods: 2 })
})

test("ctrl+c is left for the quit path", () => {
  expect(forwardKey({ name: "c", ctrl: true })).toBeNull()
  expect(forwardKey({ sequence: "\u0003" })).toBeNull()
})

test("shift+tab is backtab without the shift bit", () => {
  expect(forwardKey({ name: "tab", shift: true })).toEqual({ code: "BackTab", mods: 0 })
})

test("arrows and enter carry no mods", () => {
  expect(forwardKey({ name: "up" })).toEqual({ code: "Up", mods: 0 })
  expect(forwardKey({ name: "return" })).toEqual({ code: "Enter", mods: 0 })
})
