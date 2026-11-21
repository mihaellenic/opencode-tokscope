import { describe, expect, test } from "bun:test"
import { DEFAULT_FILTERS, rangeStartMs } from "../src/filters"
import { formatRate, modelDisplayName } from "../src/format"

describe("filters", () => {
  test("defaults match spec", () => {
    expect(DEFAULT_FILTERS).toEqual({ scope: "all", range: "today" })
  })

  test("rangeStartMs is a rolling window", () => {
    const now = 1_000_000_000
    expect(rangeStartMs("last30", now)).toBe(now - 30 * 86_400_000)
    expect(rangeStartMs("all", now)).toBeUndefined()
  })

  test("today starts at local midnight and includes the current instant", () => {
    const noon = new Date(2026, 10, 21, 12, 30).getTime()
    expect(rangeStartMs("today", noon)).toBe(new Date(2026, 10, 21).getTime())
    const justAfterMidnight = new Date(2026, 10, 21, 0, 0, 1).getTime()
    expect(rangeStartMs("today", justAfterMidnight)).toBe(new Date(2026, 10, 21).getTime())
    const lateNight = new Date(2026, 10, 21, 23, 59, 59).getTime()
    expect(rangeStartMs("today", lateNight)).toBe(new Date(2026, 10, 21).getTime())
    // A new local day moves the window forward even when less than 24 hours have elapsed.
    expect(rangeStartMs("today", new Date(2026, 10, 22, 0, 0, 1).getTime())).toBe(new Date(2026, 10, 22).getTime())
  })
})

describe("format", () => {
  test("formatRate shows one decimal", () => {
    expect(formatRate(41.34)).toBe("41.3 tok/s")
  })

  test("modelDisplayName falls back to provider/model", () => {
    const models = [{ id: "claude-sonnet-4", providerID: "anthropic", name: "Claude Sonnet 4" }]
    expect(modelDisplayName(models, "anthropic", "claude-sonnet-4")).toBe("Claude Sonnet 4")
    expect(modelDisplayName(models, "openrouter", "claude-sonnet-4")).toBe(
      "openrouter/claude-sonnet-4",
    )
    expect(modelDisplayName(undefined, "anthropic", "claude-sonnet-4")).toBe(
      "anthropic/claude-sonnet-4",
    )
  })
})
