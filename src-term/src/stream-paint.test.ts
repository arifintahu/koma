import { expect, test } from "bun:test"
import { STREAM_PAINT_CHARS, STREAM_PAINT_MS, nextStreamPaint, type StreamPaint } from "./stream-paint.ts"

const previous: StreamPaint = { shown: "hello", paintedAt: 1_000 }

test("a burst inside the window keeps the previous paint", () => {
  const next = nextStreamPaint(previous, "hello there", 1_000 + STREAM_PAINT_MS - 1, true)
  expect(next).toEqual(previous)
})

test("200 new characters publish", () => {
  const grown = "hello" + "x".repeat(STREAM_PAINT_CHARS)
  const next = nextStreamPaint(previous, grown, 1_001, true)
  expect(next).toEqual({ shown: grown, paintedAt: 1_001 })
})

test("a 150 ms gap publishes", () => {
  const next = nextStreamPaint(previous, "hello!", 1_000 + STREAM_PAINT_MS, true)
  expect(next).toEqual({ shown: "hello!", paintedAt: 1_000 + STREAM_PAINT_MS })
})

test("a shorter string publishes immediately", () => {
  const next = nextStreamPaint(previous, "hi", 1_001, true)
  expect(next).toEqual({ shown: "hi", paintedAt: 1_001 })
})

test("a settled reply always publishes", () => {
  const next = nextStreamPaint(previous, "hello!", 1_001, false)
  expect(next).toEqual({ shown: "hello!", paintedAt: 1_001 })
})
