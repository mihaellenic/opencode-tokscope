import { describe, expect, test } from "bun:test"
import type { Sample, UnavailableSample } from "../src/metric"
import { pickPageState } from "../src/page/state"

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
