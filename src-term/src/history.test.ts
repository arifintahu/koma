import { describe, expect, test } from "bun:test"
import {
  CHAT_TURNS_DEFAULT,
  countTurns,
  historyRows,
  isHistoryPrepend,
  isTurnStart,
  nextRenderFrom,
  pageFromTurn,
  visibleFromTurn,
  type HistoryRow,
} from "./history.ts"

const prompt = (sourceIndex: number): HistoryRow => ({ role: "user", content: "hi", sourceIndex })
const reply = (sourceIndex: number): HistoryRow => ({ role: "assistant", content: "ok", sourceIndex })
const shell = (sourceIndex: number): HistoryRow => ({ role: "user", content: "\u2064$ ls", sourceIndex })

function transcript(turns: number, lead = 0): HistoryRow[] {
  const rows: HistoryRow[] = []
  for (let i = 0; i < lead; i++) rows.push(reply(i))
  for (let t = 0; t < turns; t++) {
    const base = lead + t * 3
    rows.push(prompt(base), reply(base + 1), shell(base + 2))
  }
  return rows
}

describe("chat history window", () => {
  test("matches the GUI default of 30 turns", () => {
    expect(CHAT_TURNS_DEFAULT).toBe(30)
    const few = transcript(4)
    expect(visibleFromTurn(few, CHAT_TURNS_DEFAULT)).toBe(0)
    expect(countTurns(few)).toBe(4)
    expect(isTurnStart(shell(1))).toBe(false)
  })

  test("keeps rows that sit before the first of the last 30 prompts", () => {
    const exact = transcript(CHAT_TURNS_DEFAULT, 2)
    expect(visibleFromTurn(exact, 30)).toBe(0)
    expect(exact[0]?.role).toBe("assistant")
  })

  test("mounts exactly the last 30 prompts and pages 30 more", () => {
    const more = transcript(31)
    const from30 = visibleFromTurn(more, 30)
    expect(more[from30]?.role).toBe("user")
    expect(countTurns(more.slice(from30))).toBe(30)
    expect(countTurns(more.slice(0, from30))).toBe(1)

    const eighty = transcript(80)
    const tail = visibleFromTurn(eighty, 30)
    const older = pageFromTurn(eighty, tail, 30)
    expect(countTurns(eighty.slice(tail))).toBe(30)
    expect(countTurns(eighty.slice(older))).toBe(60)
    expect(older).toBeLessThan(tail)
  })

  test("a new reply while reading keeps the anchor row", () => {
    const eighty = transcript(80)
    const tail = visibleFromTurn(eighty, 30)
    const anchor = eighty[tail]
    const appended = [...eighty, prompt(10_000), reply(10_001)]
    expect(nextRenderFrom(eighty, appended, tail, false, 30, false, 30)).toBe(
      appended.findIndex((row) => row.sourceIndex === anchor?.sourceIndex),
    )
    expect(isHistoryPrepend(eighty, appended)).toBe(false)
    expect(nextRenderFrom(eighty, appended, tail, true, 30, false)).toBe(visibleFromTurn(appended, 30))
  })

  test("drops system and tool rows before counting turns", () => {
    const rows = historyRows([
      { role: "system", content: "hidden" },
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "tool", content: "result" },
      { role: "user", content: "\u2061bash done" },
    ])
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "user"])
    expect(countTurns(rows)).toBe(1)
  })
})