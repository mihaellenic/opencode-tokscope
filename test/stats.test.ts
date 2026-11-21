import { describe, expect, test } from "bun:test"
import { requestFact, type AssistantMessage, type RequestFact, type Sample } from "../src/metric"
import {
  barLevels,
  dailySeries,
  dayWindow,
  localDayKey,
  median,
  modelRows,
  percentile95,
} from "../src/stats"

const sample = (
  providerID: string,
  modelID: string,
  rate: number,
  variant?: string,
  completedAt = 0,
): Sample => ({ providerID, modelID, rate, variant, completedAt })

const fact = (overrides: Partial<RequestFact> = {}): RequestFact => ({
  providerID: "provider", modelID: "model", variant: undefined, at: 0, ...overrides,
})

describe("percentile95", () => {
  test("nearest rank, empty, singleton, and non-mutating", () => {
    const values = Array.from({ length: 20 }, (_, i) => (20 - i) * 100)
    expect(percentile95(values)).toBe(1900)
    expect(values[0]).toBe(2000)
    expect(percentile95([])).toBeNull()
    expect(percentile95([123])).toBe(123)
  })
})

describe("modelRows", () => {
  test("counts every request, per provider/model key", () => {
    expect(modelRows([fact(), fact(), fact({ modelID: "other" })], []).map(row => [row.key, row.requests]))
      .toEqual([["provider/model", 2], ["provider/other", 1]])
  })

  test("same model id under two providers stays two rows", () => {
    expect(modelRows([fact(), fact({ providerID: "other" })], []).map(row => row.key))
      .toEqual(["other/model", "provider/model"])
  })

  test("category totals sum only eligible requests; eligible count tracks them", () => {
    const [row] = modelRows([
      fact({ tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 20, cacheWrite: 0 } }),
      fact({ tokens: { input: 2, output: 3, reasoning: 0, cacheWrite: 4 } }),
    ], [])
    expect(row.tokens).toEqual({ input: 12, output: 8, reasoning: 1, cacheRead: 20, cacheWrite: 4 })
    expect(row.eligible).toEqual({ input: 2, output: 2, reasoning: 2, cacheRead: 1, cacheWrite: 2, triple: 2, response: 0 })
  })

  test("derived total skips requests missing any of the three, no zero fill", () => {
    for (const tokens of [{ input: 100, output: 50 }, { input: 100, reasoning: 50 }, { output: 100, reasoning: 50 }]) {
      const [row] = modelRows([fact({ tokens: { input: 10, output: 5, reasoning: 1 } }), fact({ tokens })], [])
      expect(row.total).toBe(16)
      expect(row.eligible.triple).toBe(1)
      if (tokens.input !== undefined) expect(row.tokens.input).toBe(110)
    }
  })

  test("cache read and write never enter total", () => {
    const [row] = modelRows([fact({ tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 1000, cacheWrite: 2000 } })], [])
    expect(row.total).toBe(16)
  })

  test("valid zero triple gives total 0, not null; no triple gives null", () => {
    expect(modelRows([fact({ tokens: { input: 0, output: 0, reasoning: 0 } })], [])[0].total).toBe(0)
    expect(modelRows([fact({ tokens: { input: 0, output: 0 } })], [])[0].total).toBeNull()
  })

  test("zero eligible category gives null, a recorded 0 gives 0", () => {
    const [row] = modelRows([fact({ tokens: { input: 0 } }), fact()], [])
    expect(row.tokens).toEqual({ input: 0, output: null, reasoning: null, cacheRead: null, cacheWrite: null })
    expect(row.eligible.input).toBe(1)
  })

  test("response median/p95 use only eligible durations", () => {
    const [row] = modelRows([1000, 2000, 3000, 4000].map(durationMs => fact({ durationMs })).concat(fact()), [])
    expect(row.responseMedian).toBe(2500)
    expect(row.responseP95).toBe(4000)
    expect(row.eligible.response).toBe(4)
    expect(modelRows(Array.from({ length: 20 }, (_, i) => fact({ durationMs: (i + 1) * 100 })), [])[0].responseP95).toBe(1900)
    expect(modelRows([fact({ durationMs: 123 })], [])[0]).toMatchObject({ responseMedian: 123, responseP95: 123 })
    expect(modelRows([fact()], [])[0]).toMatchObject({ responseMedian: null, responseP95: null })
  })

  test("errored request counts in requests/tokens but not response", () => {
    const message: AssistantMessage = {
      id: "msg_error", agent: "build", content: [],
      type: "assistant", model: { providerID: "provider", id: "model" },
      time: { created: 1000, streamed: 2000, completed: 3000 },
      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 0, write: 0 } },
      error: { type: "MessageAbortedError", message: "aborted" },
    }
    expect(modelRows([requestFact(message)], [])[0]).toMatchObject({
      requests: 1, total: 16, responseMedian: null, responseP95: null, eligible: { response: 0 },
    })
  })

  test("throughput is the median sample rate; request-only row has null throughput and throughputCalls 0", () => {
    const rows = modelRows([fact(), fact({ modelID: "other" })], [10, 100, 20].map(rate => sample("provider", "model", rate)))
    expect(rows[0]).toMatchObject({ throughput: 20, throughputCalls: 3 })
    expect(rows[1]).toMatchObject({ throughput: null, throughputCalls: 0 })
    expect(modelRows([], [sample("orphan", "model", 100)])).toEqual([])
  })

  test("ordering: throughput rows by median desc then calls desc then key; request-only rows by requests desc then key; deterministic for shuffled input", () => {
    const requests = ["fast", "calls", "a", "b", "many", "many", "x", "y"].map(modelID => fact({ modelID }))
    const samples = [sample("provider", "fast", 100), sample("provider", "calls", 10), sample("provider", "calls", 10), sample("provider", "b", 10), sample("provider", "a", 10)]
    const rows = modelRows(requests, samples)
    expect(rows.map(row => row.modelID)).toEqual(["fast", "calls", "a", "b", "many", "x", "y"])
    expect(modelRows([...requests].reverse(), [...samples].reverse())).toEqual(rows)
  })

  test("empty input gives []", () => {
    expect(modelRows([], [])).toEqual([])
  })

  test("no NaN or Infinity in any numeric field for all-zero tokens", () => {
    const rows = modelRows([fact({ tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })], [])
    const walk = (value: unknown) => {
      if (typeof value === "number") {
        expect(Number.isNaN(value)).toBe(false)
        expect(Number.isFinite(value)).toBe(true)
      } else if (value !== null && typeof value === "object") Object.values(value).forEach(walk)
    }
    walk(rows)
  })
})

test("rows combine reasoning variants of the same provider and model", () => {
  const requests = [fact({ variant: "high" }), fact({ variant: "low" }), fact()]
  const samples = [sample("provider", "model", 10, "high"), sample("provider", "model", 30)]
  const rows = modelRows(requests, samples)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ requests: 3, throughput: 20, throughputCalls: 2 })
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

describe("modelRows comparison regression", () => {
  test("groups by provider and model, sorted fastest first", () => {
    const rates =
      [
        sample("anthropic", "claude-sonnet-4", 20),
        sample("anthropic", "claude-sonnet-4", 30),
        sample("openrouter", "claude-sonnet-4", 25),
        sample("google", "gemini-pro", 5),
      ]
    const rows = modelRows(rates.map(rate => fact({ providerID: rate.providerID, modelID: rate.modelID })), rates)

    expect(rows.map((row) => row.key)).toEqual([
      "anthropic/claude-sonnet-4",
      "openrouter/claude-sonnet-4",
      "google/gemini-pro",
    ])
    expect(rows.map((row) => row.throughput)).toEqual([25, 25, 5])
    expect(rows[0].throughputCalls).toBe(2)
    expect(rows[1].throughputCalls).toBe(1)
  })

  test("request-only rows follow measured rows without losing their request count", () => {
    const rows = modelRows([
      fact({ providerID: "anthropic", modelID: "claude-sonnet-4" }),
      fact({ providerID: "google", modelID: "gemini-pro" }),
    ], [sample("anthropic", "claude-sonnet-4", 20)])

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ key: "anthropic/claude-sonnet-4", throughput: 20 })
    expect(rows[1]).toMatchObject({
      key: "google/gemini-pro",
      providerID: "google",
      modelID: "gemini-pro",
      throughput: null,
      throughputCalls: 0,
      requests: 1,
    })
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
