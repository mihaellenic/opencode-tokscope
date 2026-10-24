import { describe, expect, test } from "bun:test"
import type { Sample, UnavailableSample } from "../src/metric"
import {
  applyReasoningFilter,
  barLevels,
  comparisonRows,
  dailySeries,
  dayWindow,
  localDayKey,
  median,
} from "../src/stats"

const sample = (
  providerID: string,
  modelID: string,
  rate: number,
  variant?: string,
  completedAt = 0,
): Sample => ({ providerID, modelID, rate, variant, completedAt })

const unavailable = (providerID: string, modelID: string, variant?: string): UnavailableSample => ({
  providerID,
  modelID,
  variant,
  completedAt: 0,
})

describe("median", () => {
  test("odd picks middle; even interpolates", () => {
    expect(median([30, 10, 20])).toBe(20)
    expect(median([10, 20, 30, 40])).toBe(25)
  })

  test("empty is null", () => {
    expect(median([])).toBeNull()
  })
})

describe("comparisonRows", () => {
  test("groups by provider and model, sorted fastest first", () => {
    const rows = comparisonRows(
      [
        sample("anthropic", "claude-sonnet-4", 20),
        sample("anthropic", "claude-sonnet-4", 30),
        sample("openrouter", "claude-sonnet-4", 25),
        sample("google", "gemini-pro", 5),
      ],
      [],
    )

    expect(rows.map((row) => row.key)).toEqual([
      "anthropic/claude-sonnet-4",
      "openrouter/claude-sonnet-4",
      "google/gemini-pro",
    ])
    expect(rows.map((row) => row.median)).toEqual([25, 25, 5])
    expect(rows[0].calls).toBe(2)
    expect(rows[1].calls).toBe(1)
  })

  test("unavailable rows follow measured rows", () => {
    const rows = comparisonRows([sample("anthropic", "claude-sonnet-4", 20)], [
      unavailable("google", "gemini-pro"),
    ])

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ key: "anthropic/claude-sonnet-4", unavailable: false })
    expect(rows[1]).toEqual({
      key: "google/gemini-pro",
      providerID: "google",
      modelID: "gemini-pro",
      median: null,
      calls: 0,
      unavailable: true,
    })
  })
})

describe("applyReasoningFilter", () => {
  const samples = [
    sample("anthropic", "claude", 10, "high"),
    sample("anthropic", "claude", 20, "low"),
    sample("anthropic", "claude", 30),
  ]
  const missing = [unavailable("anthropic", "claude", "high"), unavailable("anthropic", "claude")]

  test("high keeps only the high setting", () => {
    const result = applyReasoningFilter(samples, missing, "high")
    expect(result.samples.map((item) => item.rate)).toEqual([10])
    expect(result.unavailable).toHaveLength(1)
  })

  test("unknown keeps only variant-undefined samples", () => {
    const result = applyReasoningFilter(samples, missing, "unknown")
    expect(result.samples.map((item) => item.rate)).toEqual([30])
    expect(result.unavailable).toHaveLength(1)
    expect(result.unavailable[0].variant).toBeUndefined()
  })

  test("all keeps everything including unknown", () => {
    const result = applyReasoningFilter(samples, missing, "all")
    expect(result.samples).toHaveLength(3)
    expect(result.unavailable).toHaveLength(2)
  })
})

describe("dailySeries", () => {
  const key = "anthropic/claude-sonnet-4"
  const day19 = new Date(2026, 9, 19, 10, 0, 0).getTime()
  const day21 = new Date(2026, 9, 21, 9, 0, 0).getTime()
  const now = new Date(2026, 9, 21, 12, 0, 0).getTime()
  const from = new Date(2026, 9, 19, 0, 0, 0).getTime()

  const samples = [
    sample("anthropic", "claude-sonnet-4", 10, undefined, day19),
    sample("anthropic", "claude-sonnet-4", 30, undefined, day19 + 60_000),
    sample("anthropic", "claude-sonnet-4", 5, undefined, day21),
    sample("openrouter", "claude-sonnet-4", 99, undefined, day21),
  ]

  test("buckets local days with gaps", () => {
    const series = dailySeries(samples, key, from, now)

    expect(series).toEqual([
      { date: "2026-10-19", median: 20, calls: 2 },
      { date: "2026-10-20", median: null, calls: 0 },
      { date: "2026-10-21", median: 5, calls: 1 },
    ])
  })

  test("starts at the earliest sample day without a range", () => {
    const series = dailySeries(samples, key, undefined, now)
    expect(series[0].date).toBe("2026-10-19")
    expect(series).toHaveLength(3)
  })

  test("localDayKey uses local calendar days", () => {
    expect(localDayKey(day19)).toBe("2026-10-19")
    expect(localDayKey(new Date(2026, 0, 1, 23, 59, 59).getTime())).toBe("2026-01-01")
  })
})

describe("dayWindow", () => {
  const series = Array.from({ length: 10 }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, "0")}`,
    median: 10,
    calls: 1,
  }))

  test("keeps selection visible", () => {
    const window = dayWindow(series, 5, 4)
    expect(window.end - window.start).toBeLessThanOrEqual(4)
    expect(window.start).toBeLessThanOrEqual(5)
    expect(window.end).toBeGreaterThan(5)
  })

  test("clamps at the ends", () => {
    expect(dayWindow(series, 0, 4)).toEqual({ start: 0, end: 4 })
    expect(dayWindow(series, 9, 4)).toEqual({ start: 6, end: 10 })
  })
})

describe("barLevels", () => {
  test("scales to max and marks gaps", () => {
    const series = [
      { date: "2026-10-19", median: 10 as number | null, calls: 1 },
      { date: "2026-10-20", median: null as number | null, calls: 0 },
      { date: "2026-10-21", median: 20 as number | null, calls: 1 },
    ]

    expect(barLevels(series, 8)).toEqual([4, null, 8])
  })
})
