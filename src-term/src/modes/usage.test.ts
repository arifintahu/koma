import { expect, test } from "bun:test"
import { barLine, calendarColumns, chartCells, heatLevels, fitSeries, money, pct } from "./usage.tsx"

test("a usage series keeps order when it is folded to the screen", () => {
  const fitted = fitSeries([1, 2, 3, 4], [10, 20, 30, 40], 2)
  expect(fitted.values).toEqual([3, 7])
  expect(fitted.epochs).toEqual([10, 30])
})

test("the busiest usage column is a full bar", () => {
  const cells = chartCells([0, 5, 10], 4)
  expect(cells[2]).toEqual(["█", "█", "█", "█"])
  expect(cells[0]).toEqual([" ", " ", " ", " "])
  expect(cells[1]?.filter((cell) => cell === "█").length).toBe(2)
})

test("a labeled bar keeps the value readable beside it", () => {
  expect(barLine(10, 10, 4)).toBe("████")
  expect(barLine(5, 10, 4)).toBe("██··")
  expect(barLine(0, 10, 4)).toBe("····")
})

test("usage figures stay readable", () => {
  expect(money(0.1398)).toBe("$0.1398")
  expect(pct(34944, 7569983)).toBe("0.5%")
})

test("partial rolling days and non-hour UTC offsets include every zero period", async () => {
  const { periods, foldPeriods } = await import("./usage.tsx")
  const offset = 20700, start = 1_709_251_200 - 7 * 86400, end = start + 7 * 86400 + 1
  const first = Math.floor((start + offset) / 86400) * 86400 - offset
  const points = periods([{ bucket_epoch: first, cost: 7, tokens: 40 }], start, end, 86400, offset, end - 1)
  expect(points).toHaveLength(8)
  expect(points[0]!.start).toBe(start)
  expect(points.at(-1)!.end).toBe(end)
  expect(points.reduce((s, p) => s + p.cost, 0)).toBe(7)
  expect(points.filter(p => p.cost === 0)).toHaveLength(7)
  const folded = foldPeriods(points, 3)
  expect(folded.reduce((s, p) => s + p.cost, 0)).toBe(7)
  expect(folded.reduce((s, p) => s + p.tokens, 0)).toBe(40)
  expect(folded[0]!.start).toBe(start)
  expect(folded.at(-1)!.end).toBe(end)
})


test("bars use the legacy percentile heat levels independent of height", () => {
  expect(heatLevels([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4])
  expect(heatLevels([0, 5, 5])).toEqual([0, 2, 2])
  expect(heatLevels([0, 0])).toEqual([0, 0])
})


test("calendar weeks fill every width and keep selection visible through resizing", () => {
  for (const width of [8, 46, 76, 96, 116, 156, 296]) {
    for (const selected of [0, 20, 52]) {
      const layout = calendarColumns(53, width, selected)
      expect(layout.widths.reduce((sum, n) => sum + n, 0)).toBe(width - 4)
      expect(layout.widths.every(n => n >= 1)).toBe(true)
      expect(selected).toBeGreaterThanOrEqual(layout.from)
      expect(selected).toBeLessThan(layout.from + layout.visible)
      expect(Math.max(...layout.widths) - Math.min(...layout.widths)).toBeLessThanOrEqual(1)
    }
  }
})
