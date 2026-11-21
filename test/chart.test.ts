import { describe, expect, test } from "bun:test"
import { PLOT_ROWS, axisLine, barChar } from "../src/page/chart"
import { barLevels, type DayPoint } from "../src/stats"

const point = (date: string, median: number | null, calls = median === null ? 0 : 1): DayPoint => ({
  date,
  median,
  calls,
})

test("compact chart has three rows; empty and missing series are safe, zero is not a gap", () => {
  expect(PLOT_ROWS).toBe(3)
  expect(barLevels([], PLOT_ROWS)).toEqual([])
  expect(barLevels([point("2026-10-19", null)], PLOT_ROWS)).toEqual([null])
  const levels = barLevels([point("2026-10-19", 0), point("2026-10-20", null)], PLOT_ROWS)
  expect(levels).toEqual([0, null])
  expect(barChar(levels[0], 0, PLOT_ROWS)).toBe("▁")
  expect(barChar(levels[1], 0, PLOT_ROWS)).toBe(" ")
  expect(barLevels([point("2026-10-19", 0), point("2026-10-20", 20)], PLOT_ROWS)).toEqual([0, 3])
})

describe("barChar", () => {
  test("gap days are blank", () => {
    expect(barChar(null, 0, 8)).toBe(" ")
    expect(barChar(null, 7, 8)).toBe(" ")
  })

  test("full bars use block characters", () => {
    expect(barChar(8, 7, 8)).toBe("█")
    expect(barChar(8, 0, 8)).toBe("█")
  })

  test("the top cell of a partial bar uses the matching eighth", () => {
    expect(barChar(4, 3, 8)).toBe("▄")
    expect(barChar(4, 2, 8)).toBe("█")
    expect(barChar(1, 0, 8)).toBe("▁")
  })

  test("rows above the bar are blank", () => {
    expect(barChar(2, 5, 8)).toBe(" ")
  })
})

describe("axisLine", () => {
  test("places first, selected, and last labels", () => {
    const visible = [
      point("2026-10-19", 10),
      point("2026-10-20", null),
      point("2026-10-21", 5),
      point("2026-10-22", 8),
      point("2026-10-23", 9),
      point("2026-10-24", 11),
      point("2026-10-25", 12),
      point("2026-10-26", 7),
      point("2026-10-27", 6),
      point("2026-10-28", 5),
    ]
    const line = axisLine(visible, 5)
    expect(line).toContain("Oct 19")
    expect(line).toContain("Oct 24")
    expect(line).toContain("Oct 28")
  })

  test("handles a single day without crashing", () => {
    expect(typeof axisLine([point("2026-10-21", 5)], 0)).toBe("string")
  })

  test("does not garble labels when the selection nears the last day", () => {
    const visible = Array.from({ length: 10 }, (_, index) => {
      const day = String(19 + index)
      return point(`2026-10-${day}`, 10, 1)
    })
    const line = axisLine(visible, 8)
    expect(line).toContain("Oct 19")
    expect(line.endsWith("Oct 27")).toBe(true)
    expect(line).not.toContain("Oct 28")
    expect(line.length).toBeLessThanOrEqual(20)
  })
})
