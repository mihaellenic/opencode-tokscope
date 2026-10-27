import { describe, expect, test } from "bun:test"
import type { WidgetRow } from "../src/sidebar/rank"
import type { WidgetState } from "../src/sidebar/store"
import type { WidgetEntry } from "../src/sidebar/layout"
import { widgetView } from "../src/sidebar/view"

const entries: WidgetEntry[] = [
  { model: "DeepSeek V4.1 Flash", provider: "Ollama Cloud", median: 133 },
  { model: "GLM 5.3", provider: "Ollama Cloud", median: 108 },
  { model: "DeepSeek V4 Pro 0813", provider: "Ollama Cloud", median: 102 },
]

const rows: WidgetRow[] = entries.map((entry) => ({
  key: `${entry.provider}/${entry.model}`,
  providerID: entry.provider,
  modelID: entry.model,
  median: entry.median,
  calls: 3,
}))

const state = (patch: Partial<WidgetState>): WidgetState => ({
  status: "ready",
  rows: [],
  stale: false,
  ...patch,
})

describe("widgetView", () => {
  test("renders nothing until the width is measured", () => {
    expect(widgetView(state({ status: "loading" }), undefined, [])).toBeUndefined()
  })

  test("pends with a spinner only when an empty view is still loading", () => {
    const loading = widgetView(state({ status: "loading" }), 37, [])

    expect(loading?.pending).toBe(true)
    expect(loading?.lines).toEqual([])
    expect(loading?.heading).toEqual(["TokScope · Today                tok/s"])
  })

  test("settled and failed empty views are the normal empty message, not a spinner", () => {
    for (const status of ["ready", "error"] as const) {
      const empty = widgetView(state({ status }), 37, [])

      expect(empty?.pending).toBe(false)
      expect(empty?.lines).toEqual([])
    }
  })

  test("retained rows outrank a loading or failed status and carry no stale marking", () => {
    for (const status of ["ready", "loading", "error"] as const) {
      const view = widgetView(state({ status, rows, stale: true }), 37, entries)

      expect(view?.pending).toBe(false)
      expect(view?.heading).toEqual(["TokScope · Today                tok/s"])
      expect(view?.lines).toEqual([
        "DeepSeek V4.1 Flash · Ollama Cl…  133",
        "GLM 5.3 · Ollama Cloud            108",
        "DeepSeek V4 Pro 0813 · Ollama C…  102",
      ])
    }
  })

  test("uses a later width for the heading and lines", () => {
    const view = widgetView(state({ status: "ready" }), 19, [])

    expect(view?.heading).toEqual(["TokScope · Today", "              tok/s"])
  })
})
