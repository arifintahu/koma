import { expect, test } from "bun:test"
import { charIndexAt, composerIsAhead, utf16Offset } from "./caret.ts"

test("a picked path parks the caret after the trailing space", () => {
  const text = "@src/main.rs "
  const end = [...text].length
  expect(utf16Offset(text, end)).toBe(text.length)
  expect(charIndexAt(text, text.length)).toBe(end)
})

test("the caret stays after a folder so the palette can keep browsing", () => {
  const text = "@src/"
  expect(utf16Offset(text, 5)).toBe(5)
  expect(charIndexAt(text, 5)).toBe(5)
})

test("a fast typist stays ahead of a short echo", () => {
  expect(composerIsAhead("done", "do")).toBe(true)
  expect(composerIsAhead("done", "don")).toBe(true)
  expect(composerIsAhead("done", "done")).toBe(false)
  expect(composerIsAhead("done", "")).toBe(false)
  expect(composerIsAhead("@foo", "@src/foo.ts ")).toBe(false)
})

test("an astral character counts as one daemon cursor step", () => {
  const text = "@a🙂b "
  expect([...text].length).toBe(5)
  expect(text.length).toBe(6)
  expect(utf16Offset(text, 5)).toBe(text.length)
  expect(charIndexAt(text, text.length)).toBe(5)
  expect(charIndexAt(text, utf16Offset(text, 3))).toBe(3)
})

test("daemon paste rebases newer insertion and deletion with Unicode", async () => {
  const { mergeComposerChange } = await import("./caret.ts")
  expect(mergeComposerChange("hi 🐈", "hi 🐈 newer", "hi 🐈[Image #1]")).toBe("hi 🐈[Image #1] newer")
  expect(mergeComposerChange("hello world", "hello world!", "hello [Pasted Text #1]world")).toBe("hello [Pasted Text #1]world!")
  expect(mergeComposerChange("abc tail", "bc tail", "abc [Image #1]tail")).toBe("bc [Image #1]tail")
})
