import { expect, test } from "bun:test"
import { steerPreview, stickyPreview, userPieces } from "./chat.tsx"

test("a short sticky message stays as written", () => {
  expect(stickyPreview("one line")).toBe("one line")
  expect(stickyPreview("first\nsecond")).toBe("first\nsecond")
  expect(stickyPreview("first\nsecond\n")).toBe("first\nsecond")
})

test("a long sticky message keeps two lines and an ellipsis line", () => {
  const message = "you are correctly using triple backtick right?\nlike\n```rust\n// content\n```"
  expect(stickyPreview(message)).toBe("you are correctly using triple backtick right?\nlike\n...")
})

test("a paste fence stays in the message as a reference and hides the body", () => {
  const fence = 'can you see the text?\n\n<<<pasted_text n=2 path="pastes/02-paste.txt">>>\nfirst line\nsecond line\nthird line\n<<<end_pasted_text n=2>>>'
  expect(userPieces(fence)).toEqual([
    { kind: "text", text: "can you see the text?\n\n" },
    { kind: "mark", text: "[Pasted Text #2]" },
  ])
  expect(userPieces("[Image #4]\nok now can you see this?")).toEqual([
    { kind: "mark", text: "[Image #4]" },
    { kind: "text", text: "\nok now can you see this?" },
  ])
})

test("a follow-up keeps two lines, the attachment count, and an ellipsis line", () => {
  expect(steerPreview("can you see the text?", 1)).toBe("can you see the text? · 1 attachments")
  const message = "can you see the text?\n\n[Pasted Text #2]\nmore of the pasted body"
  expect(steerPreview(message, 1)).toBe("can you see the text? · 1 attachments\n\n...")
})
