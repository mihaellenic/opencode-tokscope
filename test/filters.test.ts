import { describe, expect, test } from "bun:test"
import { DEFAULT_FILTERS, rangeStartMs } from "../src/filters"
import { formatCoverage, formatRate, modelDisplayName } from "../src/format"

describe("filters", () => {
  test("defaults match spec", () => {
    expect(DEFAULT_FILTERS).toEqual({ scope: "all", range: "last30", reasoning: "all" })
  })

  test("rangeStartMs is a rolling window", () => {
    const now = 1_000_000_000
    expect(rangeStartMs("last30", now)).toBe(now - 30 * 86_400_000)
    expect(rangeStartMs("all", now)).toBeUndefined()
  })
})

describe("format", () => {
  test("formatCoverage includes unavailable only when present", () => {
    expect(formatCoverage(183, 12)).toBe("183 measured calls; 12 unavailable")
    expect(formatCoverage(5, 0)).toBe("5 measured calls")
  })

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
