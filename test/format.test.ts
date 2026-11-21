import { expect, test } from "bun:test"
import { formatCompact, formatDuration } from "../src/format"

test("compact formats", () => {
  for (const [n, label] of [[0, "0"], [999, "999"], [1234, "1.2k"], [5234, "5.2k"], [228620, "228.6k"], [12000, "12.0k"], [1200000, "1.2M"], [4325991, "4.3M"]] as const) {
    expect(formatCompact(n)).toBe(label)
  }
})

test("compact formats promote a unit instead of rounding up to 1000", () => {
  for (const [n, label] of [[999949, "999.9k"], [999950, "1.0M"], [999999, "1.0M"], [999999999, "1.0B"]] as const) {
    expect(formatCompact(n)).toBe(label)
  }
})

test("duration formats", () => {
  for (const [n, label] of [[850, "850ms"], [3800, "3.8s"], [72000, "1m12s"], [60000, "1m00s"]] as const) {
    expect(formatDuration(n)).toBe(label)
  }
})

test("numeric formatting never emits NaN or Infinity text", () => {
  for (const n of [0, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity]) {
    for (const format of [formatCompact, formatDuration]) expect(format(n)).not.toMatch(/NaN|Infinity|undefined/)
  }
})
