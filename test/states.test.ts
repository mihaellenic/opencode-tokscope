import { expect, test } from "bun:test"
import type { RequestFact } from "../src/metric"
import { pickViewPageState } from "../src/page/state"

const request: RequestFact = { providerID: "provider", modelID: "model", variant: undefined, at: 1000 }

test("request-only history is ready for every publication kind", () => {
  for (const kind of ["loading", "partial", "cached", "ready", "error"] as const) {
    expect(pickViewPageState({ kind, requests: [request] })).toBe("ready")
  }
})

test("empty requests while loading/partial/cached is loading, ready/error is empty", () => {
  for (const kind of ["loading", "partial", "cached"] as const) expect(pickViewPageState({ kind, requests: [] })).toBe("loading")
  for (const kind of ["ready", "error"] as const) expect(pickViewPageState({ kind, requests: [] })).toBe("empty")
})
