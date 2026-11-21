import { expect, test } from "bun:test"
import type { RequestFact } from "../src/metric"
import { modelRows } from "../src/stats"

test("100k synthetic facts across 20 models", () => {
  let seed = 42
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const requests: RequestFact[] = Array.from({ length: 100_000 }, (_, i) => ({
    providerID: "provider", modelID: `model-${i % 20}`, variant: undefined, at: i,
    tokens: { input: next() % 1000, output: next() % 500, reasoning: next() % 100 },
    durationMs: (next() % 100_000) + 1,
  }))
  const start = performance.now()
  const rows = modelRows(requests, [])
  console.log(`modelRows 100k facts: ${(performance.now() - start).toFixed(2)}ms`)
  expect(rows).toHaveLength(20)
  expect(rows.reduce((sum, row) => sum + row.requests, 0)).toBe(100_000)
  for (const row of rows) {
    const matching = requests.filter(request => request.modelID === row.modelID)
    const durations = matching.map(request => request.durationMs!).sort((a, b) => a - b)
    const middle = Math.floor(durations.length / 2)
    const referenceMedian = durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2
    expect(row.responseMedian).toBe(referenceMedian)
    expect(row.responseP95).toBe(durations[Math.ceil(durations.length * 0.95) - 1])
    expect(row.total).toBe(matching.reduce((sum, request) => sum + request.tokens!.input! + request.tokens!.output! + request.tokens!.reasoning!, 0))
  }
  expect(modelRows([...requests].reverse(), [])).toEqual(rows)
})
