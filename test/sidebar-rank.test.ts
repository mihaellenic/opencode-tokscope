import { describe, expect, test } from "bun:test"
import type { Sample } from "../src/metric"
import { widgetRows } from "../src/sidebar/rank"

const HOUR_MS = 60 * 60 * 1000
const NOW = new Date(2026, 5, 15, 12).getTime()

const sample = (
  providerID: string,
  modelID: string,
  rate: number,
  completedAt: number,
  variant?: string,
): Sample => ({ providerID, modelID, rate, completedAt, variant })

const repeated = (
  providerID: string,
  modelID: string,
  rate: number,
  count: number,
  completedAt: number,
  variant?: string,
): Sample[] =>
  Array.from({ length: count }, () => sample(providerID, modelID, rate, completedAt, variant))

describe("widgetRows", () => {
  test("qualifies only pairs with three measured calls today", () => {
    const rows = widgetRows(
      [
        ...repeated("a", "x", 40, 3, NOW - HOUR_MS),
        ...repeated("b", "x", 90, 2, NOW - HOUR_MS),
        ...repeated("c", "x", 80, 3, NOW - 48 * HOUR_MS),
        ...repeated("d", "x", 70, 1, NOW - HOUR_MS),
        ...repeated("d", "x", 70, 2, NOW - 48 * HOUR_MS),
      ],
      NOW,
    )

    expect(rows.map((row) => row.key)).toEqual(["a/x"])
    expect(rows[0].calls).toBe(3)
    expect(rows[0].median).toBe(40)
  })

  test("midnight belongs to today and the previous millisecond does not", () => {
    const now = new Date(2026, 5, 15, 14, 30).getTime()
    const midnight = new Date(2026, 5, 15).getTime()
    const rows = widgetRows(
      [
        sample("edge", "x", 1_000, midnight - 1),
        sample("edge", "x", 10, midnight),
        sample("edge", "x", 20, midnight),
        sample("edge", "x", 30, midnight),
        sample("edge", "x", 2_000, now + 1),
      ],
      now,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].calls).toBe(3)
    expect(rows[0].median).toBe(20)
  })

  test("a call exactly at now is included", () => {
    const now = new Date(2026, 5, 15, 14, 30).getTime()
    expect(widgetRows(repeated("a", "x", 5, 3, now), now)).toHaveLength(1)
  })

  test("uses the calendar date rather than a rolling 24 hours", () => {
    const now = new Date(2026, 5, 15, 1, 0).getTime()
    // 23 hours ago is yesterday on the calendar, so it must not count.
    const rows = widgetRows(repeated("a", "x", 50, 3, now - 23 * HOUR_MS), now)
    expect(rows).toEqual([])
  })

  for (const [label, year, month, day] of [
    ["spring-forward (23-hour day)", 2026, 2, 8],
    ["fall-back (25-hour day)", 2026, 10, 1],
  ] as const) {
    test(`uses local calendar midnight on ${label}`, () => {
      const midnight = new Date(year, month, day).getTime()
      const now = new Date(year, month, day, 20, 15).getTime()
      const rows = widgetRows(
        [
          ...repeated("before", "x", 99, 3, midnight - 1),
          ...repeated("start", "x", 40, 3, midnight),
          ...repeated("mid", "x", 30, 3, new Date(year, month, day, 12).getTime()),
          ...repeated("now", "x", 20, 3, now),
          ...repeated("future", "x", 10, 3, now + 1),
        ],
        now,
      )

      expect(rows.map((row) => row.key)).toEqual(["start/x", "mid/x", "now/x"])
    })
  }

  test("ranks by unrounded median", () => {
    const rows = widgetRows(
      [
        ...repeated("b", "x", 30.2, 3, NOW - HOUR_MS),
        ...repeated("a", "x", 30.4, 3, NOW - HOUR_MS),
      ],
      NOW,
    )

    expect(rows.map((row) => row.key)).toEqual(["a/x", "b/x"])
  })

  test("combines reasoning settings and separates providers", () => {
    const rows = widgetRows(
      [
        sample("p1", "m", 10, NOW - HOUR_MS, "high"),
        sample("p1", "m", 20, NOW - HOUR_MS, "low"),
        sample("p1", "m", 30, NOW - HOUR_MS),
        sample("p2", "m", 5, NOW - HOUR_MS, "high"),
        sample("p2", "m", 6, NOW - HOUR_MS, "low"),
        sample("p2", "m", 7, NOW - HOUR_MS),
      ],
      NOW,
    )

    expect(rows.map((row) => row.key)).toEqual(["p1/m", "p2/m"])
    expect(rows.map((row) => row.calls)).toEqual([3, 3])
    expect(rows.map((row) => row.median)).toEqual([20, 6])
  })

  test("tie-breaks equal medians by calls then key order", () => {
    const rows = widgetRows(
      [
        ...repeated("a", "x", 50, 4, NOW - HOUR_MS),
        ...repeated("c", "x", 50, 4, NOW - HOUR_MS),
        ...repeated("b", "x", 50, 3, NOW - HOUR_MS),
      ],
      NOW,
    )

    expect(rows.map((row) => row.key)).toEqual(["a/x", "c/x", "b/x"])
  })

  test("caps entries at three", () => {
    const rows = widgetRows(
      [
        ...repeated("a", "x", 100, 3, NOW - HOUR_MS),
        ...repeated("b", "x", 90, 3, NOW - HOUR_MS),
        ...repeated("c", "x", 80, 3, NOW - HOUR_MS),
        ...repeated("d", "x", 70, 3, NOW - HOUR_MS),
      ],
      NOW,
    )

    expect(rows.map((row) => row.key)).toEqual(["a/x", "b/x", "c/x"])
  })
})
