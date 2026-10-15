import { expect, test } from "bun:test"
import { chartCells, fitSeries, money, pct } from "./usage.tsx"

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

test("usage figures stay readable", () => {
  expect(money(0.1398)).toBe("$0.1398")
  expect(pct(34944, 7569983)).toBe("0.5%")
})
