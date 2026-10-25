import { describe, expect, test } from "bun:test"
import { formatHm } from "../src/format"
import type { Sample } from "../src/metric"
import {
  bannerMessage,
  cachedMessage,
  footerStatusSuffix,
  partialMessage,
  refreshFailedMessage,
} from "../src/page/heading-status"
import type { PageView } from "../src/page/state"

const sample: Sample = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4",
  variant: undefined,
  rate: 20,
  completedAt: 1_000,
}

const checkedAt = new Date(2026, 0, 2, 14, 5).getTime()

const view = (overrides: Partial<PageView> = {}): PageView => ({
  kind: "ready",
  samples: [sample],
  unavailable: [],
  persistence: "ok",
  lastCheckedAt: checkedAt,
  ...overrides,
})

describe("formatHm", () => {
  test("formats local wall-clock time as two-digit hh:mm", () => {
    expect(formatHm(checkedAt)).toBe("14:05")
    expect(formatHm(new Date(2026, 0, 2, 9, 7).getTime())).toBe("09:07")
    expect(formatHm(new Date(2026, 0, 2, 0, 0).getTime())).toBe("00:00")
  })
})

describe("heading status messages", () => {
  test("partial acquisition reports incomplete results", () => {
    expect(partialMessage(view({ kind: "partial" }))).toBe("History loading — results incomplete")
  })

  test("a revalidating cached window reports when it was last checked", () => {
    expect(cachedMessage(view({ kind: "cached" }))).toBe("Cached · last checked 14:05 · refreshing…")
    expect(cachedMessage(view({ kind: "cached", lastCheckedAt: undefined }))).toBe("Cached · refreshing…")
  })

  test("a failed refresh says cached results are still shown", () => {
    expect(refreshFailedMessage(view({ kind: "error" }))).toBe("Refresh failed — showing cached results")
  })

  test("an unavailable cache appends the not-saved suffix to every banner", () => {
    for (const message of [
      partialMessage(view({ kind: "partial", persistence: "unavailable" })),
      cachedMessage(view({ kind: "cached", persistence: "unavailable" })),
      refreshFailedMessage(view({ kind: "error", persistence: "unavailable" })),
    ]) {
      expect(message.endsWith(" · Cache not saved")).toBe(true)
    }
    expect(partialMessage(view({ kind: "partial" }))).not.toContain("Cache not saved")
  })

  test("only unsettled kinds carry a banner", () => {
    expect(bannerMessage(view({ kind: "loading" }))).toBeUndefined()
    expect(bannerMessage(view({ kind: "ready" }))).toBeUndefined()
    expect(bannerMessage(view({ kind: "partial" }))).toBe("History loading — results incomplete")
    expect(bannerMessage(view({ kind: "cached" }))).toContain("refreshing…")
  })

  test("a failed refresh only banners while retained rows are on screen", () => {
    expect(bannerMessage(view({ kind: "error" }))).toBe("Refresh failed — showing cached results")
    expect(bannerMessage(view({ kind: "error", samples: [], unavailable: [] }))).toBeUndefined()
    expect(
      bannerMessage(view({ kind: "error", samples: [], unavailable: [{ ...sample, completedAt: 2_000 }] })),
    ).toBe("Refresh failed — showing cached results")
  })
})

describe("footerStatusSuffix", () => {
  test("a ready view reports its check time and the shared cache", () => {
    expect(footerStatusSuffix(view())).toBe(" · checked 14:05 · cache: shared")
  })

  test("a cached view names the shared cache while it revalidates", () => {
    expect(footerStatusSuffix(view({ kind: "cached" }))).toBe(" · cache: shared")
  })

  test("unsettled or failed views add nothing to the footer", () => {
    expect(footerStatusSuffix(view({ kind: "loading" }))).toBe("")
    expect(footerStatusSuffix(view({ kind: "partial" }))).toBe("")
    expect(footerStatusSuffix(view({ kind: "error" }))).toBe("")
  })
})
