import { describe, expect, test } from "bun:test"
import type { WidgetEntry } from "../src/sidebar/layout"
import type { WidgetState } from "../src/sidebar/store"
import { widgetView } from "../src/sidebar/view"

const entries: WidgetEntry[] = [
  { model: "DeepSeek V4.1 Flash", provider: "Ollama Cloud", median: 133 },
  { model: "GLM 5.3", provider: "Ollama Cloud", median: 108 },
  { model: "DeepSeek V4 Pro 0813", provider: "Ollama Cloud", median: 102 },
]

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

  test("derives loading, error, and empty states from the current state", () => {
    const loading = widgetView(state({ status: "loading" }), 37, [])
    const error = widgetView(state({ status: "error" }), 37, [])
    const empty = widgetView(state({ status: "ready" }), 37, [])

    expect(loading?.status).toBe("loading")
    expect(loading?.lines).toEqual([])
    expect(error?.status).toBe("error")
    expect(error?.lines).toEqual([])
    expect(empty?.status).toBe("ready")
    expect(empty?.lines).toEqual([])
  })

  test("derives the ready ranking and heading at the measured width", () => {
    const view = widgetView(state({ status: "ready" }), 37, entries)

    expect(view?.title).toBe("TokScope · 24h")
    expect(view?.heading).toEqual(["TokScope · 24h                  tok/s"])
    expect(view?.lines).toEqual([
      "DeepSeek V4.1 Flash · Ollama Cl…  133",
      "GLM 5.3 · Ollama Cloud            108",
      "DeepSeek V4 Pro 0813 · Ollama C…  102",
    ])
  })

  test("marks retained rows stale in the heading and title", () => {
    const view = widgetView(state({ status: "ready", stale: true }), 37, entries)

    expect(view?.title).toBe("TokScope · 24h (stale)")
    expect(view?.heading[0]).toBe("TokScope · 24h (stale)          tok/s")
    expect(view?.lines).toHaveLength(3)
  })

  test("uses a later width for the heading and lines", () => {
    const view = widgetView(state({ status: "ready" }), 19, [])

    expect(view?.heading).toEqual(["TokScope · 24h", "              tok/s"])
  })
})
