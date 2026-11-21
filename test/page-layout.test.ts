import { expect, test } from "bun:test"
import { stringWidth } from "bun"
import type { RequestFact } from "../src/metric"
import { detailContent, detailLines, tableLayout, tableLines, tokenBar } from "../src/page/layout"
import { modelRows, windowRange, type ModelRow } from "../src/stats"

const fact = (overrides: Partial<RequestFact> = {}): RequestFact => ({
  providerID: "provider-a", modelID: "model-alpha", at: 1000, variant: undefined, ...overrides,
})
const full = fact({ tokens: { input: 184200, output: 31540, reasoning: 12880, cacheRead: 96400, cacheWrite: 8200 }, durationMs: 3800 })
const rows = modelRows([full, fact({ modelID: "missing" }), fact({ modelID: "zero", tokens: { input: 0, output: 0, reasoning: 0 } })], [])
const complete = modelRows([full, { ...full, durationMs: 11200 }], [
  { providerID: full.providerID, modelID: full.modelID, variant: undefined, rate: 54.3, completedAt: 1000 },
])[0]
const labels = (row: ModelRow) => ({ name: row.modelID, provider: row.providerID })
const widths = [180, 120, 80, 50, 30]

test("layout bundles with the plugin's node target before host runtime execution", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../src/page/layout.ts", import.meta.url).pathname],
    target: "node",
    format: "esm",
  })
  expect(result.success).toBe(true)
  expect(result.outputs).toHaveLength(1)
})

test("lines never exceed width; Requests and Tokens columns exist", () => {
  for (const width of widths) {
    const table = tableLines(rows, labels, rows[0].key, width)
    expect(table.header).toContain(width < 40 ? "Req" : "Requests")
    expect(table.header).toContain(width < 40 ? "Tok" : "Tokens")
    for (const line of [table.header, ...table.lines, ...rows.flatMap(row => detailLines(row, labels(row), width))]) expect(stringWidth(line)).toBeLessThanOrEqual(width)
    expect(table.lines.join("\n")).toContain("n/a")
    expect(detailLines(complete, labels(complete), width).join("\n")).toContain("577.6k")
  }
})

test("no coverage text or footer counts for partial data", () => {
  const partial = modelRows([full, fact({ tokens: { input: 12 } })], [])[0]
  const table = tableLines([partial], labels, partial.key, 120)
  const text = [table.header, ...table.lines, ...detailLines(partial, labels(partial), 120)].join("\n")
  expect(text).not.toMatch(/\d+\s*\/\s*\d+|measured calls|unavailable|coverage|eligible|more rows/i)
  expect(table.lines).toHaveLength(1)
})

test("n/a for missing Tokens, Response and Speed; recorded zero renders 0", () => {
  const missing = rows.find(row => row.modelID === "missing")!
  expect(tableLines([missing], labels, undefined, 180).lines[0].match(/n\/a/g)).toHaveLength(3)
  const zero = rows.find(row => row.modelID === "zero")!
  expect(detailLines(zero, labels(zero), 80).join("\n")).toMatch(/Generated\s+0 /)
  expect(detailLines(missing, labels(missing), 80).join("\n")).toMatch(/Generated\s+n\/a/)
})

test("Model keeps 12 display cells and truncates with an ellipsis", () => {
  for (const name of ["long-model-identifier-that-does-not-fit", "模型".repeat(15), "👩‍💻".repeat(20)]) {
    const table = tableLines(rows.slice(0, 1), () => ({ name, provider: "provider" }), undefined, 30)
    expect(tableLayout(30).modelWidth).toBe(12)
    expect(table.lines[0]).toContain("…")
    expect(stringWidth(table.lines[0])).toBeLessThanOrEqual(30)
  }
  expect(tableLines(rows.slice(0, 1), () => ({ name: "long-model-identifier", provider: "p" }), undefined, 30).lines[0]).toStartWith("  long-model-… ")
  expect(tableLines(rows.slice(0, 1), () => ({ name: "模型".repeat(15), provider: "p" }), undefined, 30).lines[0]).toStartWith("  模型模型模…  ")
})

test("bars shrink before columns drop in provider, response, speed order", () => {
  let previous = 8
  for (let width = 180; width >= 30; width -= 2) {
    const layout = tableLayout(width)
    expect(layout.barWidth).toBeLessThanOrEqual(previous)
    previous = layout.barWidth
    if (!layout.showProvider || !layout.showResponse || !layout.showSpeed) expect(layout.barWidth).toBe(0)
    if (!layout.showResponse) expect(layout.showProvider).toBe(false)
    if (!layout.showSpeed) expect(layout.showResponse).toBe(false)
    expect(layout.modelWidth).toBeGreaterThanOrEqual(12)
  }
  for (const width of [0, 1, 10, 29]) {
    const table = tableLines(rows, labels, undefined, width)
    for (const line of [table.header, ...table.lines, ...detailLines(complete, labels(complete), width)]) expect(stringWidth(line)).toBeLessThanOrEqual(width)
  }
})

test("same name under two providers shows provider when it fits; narrow detail preserves identity", () => {
  const pair = modelRows([fact(), fact({ providerID: "provider-b" })], [])
  const table = tableLines(pair, labels, pair[1].key, 120)
  expect(table.lines[0]).toContain("provider-a")
  expect(table.lines[1]).toContain("provider-b")
  expect(table.lines[1]).toStartWith("› ")
  expect(tableLayout(30).showProvider).toBe(false)
  expect(detailLines(pair[1], labels(pair[1]), 30).join("\n")).toContain("provider-b")
  const long = { name: "模型".repeat(30), provider: "long-provider-id-".repeat(5) }
  const detail = detailLines(pair[1], long, 30)
  expect(detail.join("").replaceAll(" ", "")).toContain(long.provider)
  expect(detail.join("")).toContain(long.name)
  for (const line of detail) expect(stringWidth(line)).toBeLessThanOrEqual(30)
})

test("tokenBar handles zero, null, full and oversized values", () => {
  expect(tokenBar(null, 10, 8)).toBe("")
  expect(tokenBar(1, 0, 8)).toBe("")
  expect(tokenBar(10, 10, 8)).toBe("█".repeat(8))
  for (const value of [0, 1, 100, NaN, Infinity]) {
    expect(stringWidth(tokenBar(value, 10, 8))).toBeLessThanOrEqual(8)
    expect(tokenBar(value, 10, -1)).toBe("")
  }
})

test("detail leads with cache reuse bar whose line equals its colored parts", () => {
  const detail = detailContent(complete, labels(complete), 80)
  const bar = detail.reuseBar!
  expect(bar).not.toBeNull()
  expect(bar.label).toBe("Cache reuse 33%  ")
  expect(detail.lines[bar.lineIndex]).toBe(bar.label + bar.filled + bar.empty)
  expect(stringWidth(bar.filled + bar.empty)).toBe(24)
  expect(bar.filled).toBe("█".repeat(8))
  expect(bar.empty).toBe("░".repeat(16))
})

test("prompt and generated lines align and add up from their parts", () => {
  const text = detailLines(complete, labels(complete), 120)
  expect(text).toContain("Prompt      577.6k · fresh 368.4k + cached 192.8k + written 16.4k")
  expect(text).toContain("Generated    88.8k · output 63.1k + reasoning 25.8k")
  // Prompt = input + cache read + cache write; Generated = output + reasoning.
  expect(368400 + 192800 + 16400).toBe(577600)
  expect(63080 + 25760).toBe(88840)
})

test("large detail numbers are abbreviated; small ones stay exact", () => {
  const big = modelRows([fact({ tokens: { input: 5234, output: 999, reasoning: 0, cacheRead: 4325991, cacheWrite: 0 } })], [])[0]
  const text = detailLines(big, labels(big), 120).join("\n")
  expect(text).toContain("fresh 5.2k + cached 4.3M")
  expect(text).toContain("output 999 + reasoning 0")
  expect(text).not.toMatch(/\d,\d{3}/)
  const many = modelRows(Array.from({ length: 2877 }, () => fact()), [])[0]
  expect(detailLines(many, labels(many), 120)[0]).toBe("model-alpha · provider-a · 2.9k requests")
})

test("zero cache write is left out of the prompt breakdown", () => {
  const noWrite = modelRows([fact({ tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 30, cacheWrite: 0 } })], [])[0]
  const text = detailLines(noWrite, labels(noWrite), 120).join("\n")
  expect(text).toContain("Cache reuse 75%")
  expect(text).toContain("fresh 10 + cached 30")
  expect(text).not.toContain("written")
})

test("cache reuse never rounds a mixed prompt to 0% or 100%", () => {
  const almost = modelRows([fact({ tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 100000, cacheWrite: 0 } })], [])[0]
  const none = modelRows([fact({ tokens: { input: 100000, output: 1, reasoning: 0, cacheRead: 1, cacheWrite: 0 } })], [])[0]
  const all = modelRows([fact({ tokens: { input: 0, output: 1, reasoning: 0, cacheRead: 10, cacheWrite: 0 } })], [])[0]
  const never = modelRows([fact({ tokens: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })], [])[0]
  expect(detailContent(almost, labels(almost), 80).reuseBar!.label).toBe("Cache reuse 99%  ")
  expect(detailContent(almost, labels(almost), 80).reuseBar!.empty).toHaveLength(1)
  expect(detailContent(none, labels(none), 80).reuseBar!.label).toBe("Cache reuse 1%  ")
  expect(detailContent(none, labels(none), 80).reuseBar!.filled).toHaveLength(1)
  expect(detailContent(all, labels(all), 80).reuseBar!.empty).toBe("")
  expect(detailContent(never, labels(never), 80).reuseBar!.filled).toBe("")
})

test("incomplete cache data is n/a, never zero; empty prompt has no ratio", () => {
  const partial = modelRows([fact({ tokens: { input: 12, output: 3, reasoning: 0 } })], [])[0]
  const text = detailLines(partial, labels(partial), 80).join("\n")
  expect(text).toContain("Cache reuse n/a")
  expect(text).toMatch(/Prompt\s+n\/a/)
  expect(detailContent(partial, labels(partial), 80).reuseBar).toBeNull()
  const empty = modelRows([fact({ tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })], [])[0]
  expect(detailLines(empty, labels(empty), 80).join("\n")).toContain("Cache reuse n/a")
  expect(detailLines(empty, labels(empty), 80).join("\n")).toMatch(/Prompt\s+0 /)
})

test("narrow detail shrinks the bar, then drops it before the percentage; lines stay in width", () => {
  expect(stringWidth(detailContent(complete, labels(complete), 30).reuseBar!.filled + detailContent(complete, labels(complete), 30).reuseBar!.empty)).toBe(13)
  expect(detailContent(complete, labels(complete), 20).reuseBar).toBeNull()
  expect(detailLines(complete, labels(complete), 20)).toContain("Cache reuse 33%")
  for (const width of [0, 1, 10, 17, 20, 21, 22, 30, 80, 180]) {
    for (const line of detailLines(complete, labels(complete), width)) expect(stringWidth(line)).toBeLessThanOrEqual(width)
  }
})

test("response keeps plain wording with percentiles in parentheses", () => {
  const text = detailLines(complete, labels(complete), 80).join("\n")
  expect(text).toContain("Median response 7.5s (p50)")
  expect(text).toContain("Most responses finished within 11.2s (p95)")
  expect(detailLines(complete, labels(complete), 24).join(" ")).toContain("Median response 7.5s (p50)")
})

test("details carry no stale composition or Tokens notes; all output is free of numeric artifacts", () => {
  const text = detailLines(complete, labels(complete), 120).join("\n")
  expect(text).not.toMatch(/not in Tokens|complete records|coverage|eligible|\d+\s*\/\s*\d+|\*/i)
  const zero = rows.find(row => row.modelID === "zero")!
  expect(detailContent(zero, labels(zero), 80).reuseBar).toBeNull()
  const missing = rows.find(row => row.modelID === "missing")!
  for (const label of ["Cache reuse", "Prompt", "Generated"]) {
    expect(detailLines(missing, labels(missing), 80).join("\n")).toMatch(new RegExp(`${label}\\s+n/a`))
  }
  for (const fixture of [[], rows, [complete], [zero]]) {
    for (const width of widths) {
      const table = tableLines(fixture, labels, undefined, width)
      expect([table.header, ...table.lines, ...fixture.flatMap(row => detailLines(row, labels(row), width))].join("\n")).not.toMatch(/NaN|Infinity|undefined/)
    }
  }
})

test("terminal control sequences in labels cannot break width or line boundaries", () => {
  const unsafe = () => ({ name: "\x1b[31m模型\nname\x1b[0m", provider: "provider\tname" })
  for (const width of widths) {
    const table = tableLines(rows, unsafe, undefined, width)
    for (const line of [table.header, ...table.lines, ...detailLines(complete, unsafe(), width)]) {
      expect(stringWidth(line)).toBeLessThanOrEqual(width)
      expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
    }
  }
})

test("table returns every row; caller windowing keeps selected row", () => {
  const table = tableLines(rows, labels, rows[2].key, 80)
  expect(table.lines).toHaveLength(rows.length)
  const range = windowRange(rows.length, 2, 1)
  expect(table.lines.slice(range.start, range.end)[0]).toStartWith("› ")
})

test("missing response is plainly unavailable; nonfinite speed never leaks into a cell", () => {
  const missing = rows.find(row => row.modelID === "missing")!
  expect(detailLines(missing, labels(missing), 80).join("\n")).toContain("Median response n/a (p50)")
  expect(detailLines(missing, labels(missing), 80).join("\n")).not.toContain("within n/a")
  for (const throughput of [NaN, Infinity, -Infinity]) {
    expect(tableLines([{ ...complete, throughput }], labels, undefined, 80).lines[0]).not.toMatch(/NaN|Infinity/)
  }
})
