import { expect, test } from "bun:test"
import { placeOf } from "./place.ts"

test("settings menu floats, the pages replace the chat", () => {
  expect(placeOf({ Settings: { page: "menu" } })).toBe("overlay")
  expect(placeOf({ Settings: { page: "general" } })).toBe("full")
  expect(placeOf({ Settings: { page: "models" } })).toBe("full")
})

test("bash stays over the chat and help takes the screen", () => {
  expect(placeOf({ Bash: { jobs: [] } })).toBe("overlay")
  expect(placeOf({ Help: { query: "" } })).toBe("full")
  expect(placeOf({ Skill: {} })).toBe("overlay")
  expect(placeOf({ Effort: {} })).toBe("overlay")
})

test("the extension use picker floats and browse does not", () => {
  expect(placeOf({ Extensions: { mode: "use" } })).toBe("overlay")
  expect(placeOf({ Extensions: { mode: "browse" } })).toBe("full")
})

test("a paste editor replaces the chat, the attachment list does not", () => {
  expect(placeOf({ Attachments: { items: [] } })).toBe("overlay")
  expect(placeOf({ Attachments: { editor: [1, { lines: [] }] } })).toBe("full")
})

test("chat and rewind are not menus", () => {
  expect(placeOf("Chat")).toBeNull()
  expect(placeOf({ Chat: null })).toBeNull()
  expect(placeOf({ MessageRewind: {} })).toBeNull()
})
