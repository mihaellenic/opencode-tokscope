import { describe, expect, test } from "bun:test"
import type { Sample } from "../src/metric"
import { WIDGET_WINDOW_MS, widgetRows } from "../src/sidebar/rank"

const HOUR_MS = 60 * 60 * 1000
const NOW = 1_000_000_000_000

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
  test("qualifies only pairs with three measured calls inside the rolling window", () => {
    const rows = widgetRows(
      [
        ...repeated("a", "x", 40, 3, NOW - HOUR_MS),
        ...repeated("b", "x", 90, 2, NOW - HOUR_MS),
        ...repeated("c", "x", 80, 3, NOW - 25 * HOUR_MS),
        ...repeated("d", "x", 70, 1, NOW - HOUR_MS),
        ...repeated("d", "x", 70, 2, NOW - 25 * HOUR_MS),
      ],
      NOW,
    )

    expect(rows.map((row) => row.key)).toEqual(["a/x"])
    expect(rows[0].calls).toBe(3)
    expect(rows[0].median).toBe(40)
  })

  test("window boundary is strict and excludes the future", () => {
    const rows = widgetRows(
      [
        sample("edge", "x", 1_000, NOW - WIDGET_WINDOW_MS),
        sample("edge", "x", 10, NOW - WIDGET_WINDOW_MS + 1),
        sample("edge", "x", 20, NOW - WIDGET_WINDOW_MS + 1),
        sample("edge", "x", 30, NOW - WIDGET_WINDOW_MS + 1),
        sample("edge", "x", 2_000, NOW + 1),
      ],
      NOW,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].calls).toBe(3)
    expect(rows[0].median).toBe(20)
  })

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
