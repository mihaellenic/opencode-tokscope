import { describe, expect, test } from "bun:test"
import type { Sample, UnavailableSample } from "../src/metric"
import { pickPageState, pickViewPageState, type PageView } from "../src/page/state"

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

describe("pickPageState", () => {
  test("loading while the resource has no result", () => {
    expect(pickPageState(undefined, [], [])).toBe("loading")
  })

  test("error when the resource carries an error", () => {
    expect(pickPageState({ error: new Error("boom") }, [sample], [unavailable])).toBe("error")
  })

  test("empty when no measured and no unavailable history matches", () => {
    expect(pickPageState({ error: undefined }, [], [])).toBe("empty")
  })

  test("unmeasurable when history exists but nothing is recoverable", () => {
    expect(pickPageState({ error: undefined }, [], [unavailable])).toBe("unmeasurable")
  })

  test("ready when any sample is measurable", () => {
    expect(pickPageState({ error: undefined }, [sample], [])).toBe("ready")
  })
})

const view = (overrides: Partial<PageView> = {}): PageView => ({
  kind: "ready",
  samples: [sample],
  unavailable: [],
  persistence: "ok",
  lastCheckedAt: 1_000,
  ...overrides,
})

describe("pickViewPageState", () => {
  test("loading while the service has nothing to show yet", () => {
    expect(pickViewPageState(view({ kind: "loading", samples: [] }))).toBe("loading")
  })

  test("published partial and cached data use the ready content", () => {
    expect(pickViewPageState(view({ kind: "partial" }))).toBe("ready")
    expect(pickViewPageState(view({ kind: "cached" }))).toBe("ready")
  })

  test("a failed refresh keeps its retained rows on screen", () => {
    expect(pickViewPageState(view({ kind: "error" }))).toBe("ready")
    expect(pickViewPageState(view({ kind: "error", samples: [], unavailable: [unavailable] }))).toBe("unmeasurable")
  })

  test("a failed refresh with nothing retained is an error", () => {
    expect(pickViewPageState(view({ kind: "error", samples: [], unavailable: [] }))).toBe("error")
  })

  test("an empty or unmeasurable cache keeps its own state", () => {
    expect(pickViewPageState(view({ samples: [], unavailable: [] }))).toBe("empty")
    expect(pickViewPageState(view({ samples: [], unavailable: [unavailable] }))).toBe("unmeasurable")
  })
})
