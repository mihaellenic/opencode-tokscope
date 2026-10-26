import { describe, expect, test } from "bun:test"
import type { Sample, UnavailableSample } from "../src/metric"
import { pickViewPageState, type PageView } from "../src/page/state"

const sample: Sample = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4",
  variant: undefined,
  rate: 20,
  completedAt: 1_000,
}

const unavailable: UnavailableSample = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4",
  variant: undefined,
  completedAt: 1_000,
}

const PENDING = ["loading", "partial", "cached", "error"] as const
const SETTLED = ["ready", "error"] as const

const view = (overrides: Partial<PageView> = {}): PageView => ({
  kind: "ready",
  samples: [sample],
  unavailable: [],
  ...overrides,
})

describe("pickViewPageState", () => {
  test("retained measurements outrank every pending or failed publication", () => {
    for (const kind of PENDING) {
      expect(pickViewPageState(view({ kind }))).toBe("ready")
    }
  })

  test("retained unavailable history outranks every pending or failed publication", () => {
    for (const kind of PENDING) {
      expect(pickViewPageState(view({ kind, samples: [], unavailable: [unavailable] }))).toBe("unmeasurable")
    }
  })

  test("spins only while an empty view is still pending", () => {
    for (const kind of ["loading", "partial", "cached"] as const) {
      expect(pickViewPageState(view({ kind, samples: [], unavailable: [] }))).toBe("loading")
    }
  })

  test("a settled or failed empty view is the normal empty state", () => {
    for (const kind of SETTLED) {
      expect(pickViewPageState(view({ kind, samples: [], unavailable: [] }))).toBe("empty")
    }
  })

  test("a measured call keeps the ready content even beside unavailable history", () => {
    expect(pickViewPageState(view({ samples: [sample], unavailable: [unavailable] }))).toBe("ready")
  })
})
