import { expect, test } from "bun:test"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import type { HistoryService, ViewState } from "../../src/history/service"
import type { RequestFact } from "../../src/metric"
import { formatDayLabel } from "../../src/format"
import { localDayKey } from "../../src/stats"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"

function scrollbox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable) return root
  for (const child of root.getChildren()) {
    const found = scrollbox(child)
    if (found) return found
  }
}

ensureSolidTransformPlugin()
const { renderPage } = await import("./page-render")

test("page renders request-only analytics, retaining selection across publications", async () => {
  const now = new Date(2026, 9, 31, 12).getTime()
  const requests: RequestFact[] = [
    { providerID: "provider-a", modelID: "same", at: now, variant: "high", tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 20, cacheWrite: 0 }, durationMs: 3800 },
    { providerID: "provider-b", modelID: "same", at: now, variant: undefined },
  ]
  const [state, setState] = createSignal<ViewState>({ requests, samples: [], unavailable: [], variants: [], kind: "ready", lastCheckedAt: now, scanned: 1, refreshing: false, refreshFailed: false, persistence: "ok" })
  let commands: { bind?: string; run: () => unknown }[] = []
  let chosen: string | undefined
  const context = {
    theme: { text: { base: "#ffffff", muted: "#888888" }, background: { base: "#000000" }, syntax: { string: "#00ff00", function: "#0000ff", number: "#ffff00" } },
    data: { location: {
      default: () => ({ directory: "/project" }),
      model: { sync: async () => {}, list: () => requests.map(r => ({ id: r.modelID, providerID: r.providerID, name: "Same model" })) },
      provider: { sync: async () => {}, list: () => requests.map(r => ({ id: r.providerID, name: r.providerID })) },
    } },
    keymap: { layer: (factory: () => { commands: typeof commands }) => { commands = factory().commands } },
    ui: { dialog: { select: async () => chosen } },
  } as unknown as Plugin.Context
  let query: { directory: string | undefined; range: string } | undefined
  const service = { view: (input: NonNullable<typeof query>) => { query = input; return state } } as unknown as HistoryService
  const setup = await renderPage(context, service, 100, 40)
  const run = async (bind: string) => { await commands.find(c => c.bind === bind)!.run(); await setup.flush() }
  try {
    await setup.flush()
    let frame = setup.captureCharFrame()
    expect(query).toEqual({ directory: undefined, range: "today" })
    expect(frame).toContain("Requests")
    expect(frame).toMatch(/Tokscope\s+· all projects \(s\) · today \(t\)/)
    expect(frame).not.toMatch(/reasoning:|r reasoning/)
    expect(commands.some(command => command.bind === "r")).toBe(false)
    expect(frame).toContain("Cache reuse 67%")
    expect(frame).toMatch(/Prompt\s+30 · fresh 10 \+ cached 20/)
    expect(frame).toMatch(/Generated\s+6 · output 5 \+ reasoning 1/)
    expect(frame).toContain("Median response 3.8s (p50)")
    expect(frame).toContain("Speed by day · tok/s")
    expect(frame).not.toMatch(/measured calls;|coverage|unavailable.*calls/)
    const graphic = setup.captureSpans().lines.find(line => line.spans.some(span => span.text.includes("░")))!
    for (const [glyph, rgb] of [["█", [255, 255, 255]], ["░", [136, 136, 136]]] as const) {
      expect(graphic.spans.find(span => span.text.includes(glyph))!.fg.toInts().slice(0, 3)).toEqual([...rgb])
    }
    await run("down")
    expect(setup.captureCharFrame()).toContain("Same model · provider-b")
    setState(previous => ({ ...previous, requests: [...previous.requests, requests[0]] }))
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("Same model · provider-b")
    frame = setup.captureCharFrame()
    expect(frame).toMatch(/Prompt\s+n\/a/)
    expect(frame).toContain("Most responses n/a (p95)")
    expect(frame).toContain("No measurable trend")

    // The multi-day trend below needs a window wider than today.
    chosen = "last30"
    await run("t")
    expect(query).toEqual({ directory: undefined, range: "last30" })
    expect(setup.captureCharFrame()).toMatch(/all projects \(s\) · last 30 days \(t\)/)

    setState(previous => ({ ...previous, samples: [
      { providerID: "provider-a", modelID: "same", variant: "high", completedAt: now - 86400000, rate: 0 },
      { providerID: "provider-a", modelID: "same", variant: "high", completedAt: now, rate: 20 },
    ] }))
    await setup.flush()
    await run("up")
    frame = setup.captureCharFrame()
    expect(frame).toMatch(/Prompt\s+60 /)
    expect(frame).toContain(`${formatDayLabel(localDayKey(now))} · 20.0 tok/s`)
    expect(frame).not.toMatch(/\d+ calls/)
    const chart = frame.split("Speed by day · tok/s")[1].split("\n").slice(1, 4)
    expect(chart).toHaveLength(3)
    expect(chart.every(line => /[█▁-▇]/u.test(line))).toBe(true)
    await run("left")
    expect(setup.captureCharFrame()).toContain(`${formatDayLabel(localDayKey(now - 86400000))} · 0.0 tok/s`)
    setState(previous => ({ ...previous, scanned: 2 }))
    await setup.flush()
    expect(setup.captureCharFrame()).toContain(`${formatDayLabel(localDayKey(now - 86400000))} · 0.0 tok/s`)

    // At a compact viewport table windowing reserves space for detail AND the full chart.
    setState(previous => ({ ...previous, requests: [...previous.requests,
      ...Array.from({ length: 40 }, (_, index) => ({ ...requests[1], providerID: "provider-z", modelID: `other-${index}` })),
    ] }))
    setup.resize(80, 30)
    await setup.flush()
    frame = setup.captureCharFrame()
    expect(frame).toContain("more rows")
    expect(frame).toContain("Same model · provider-a")
    expect(frame).toContain("Speed by day · tok/s")
    expect(frame).toContain("0.0 tok/s")
    expect(frame).toMatch(/reset\s+history\s+in\s+palette/)
    await run("down")
    expect(setup.captureCharFrame()).toContain("Same model · provider-b")
    setup.resize(50, 40)
    await setup.flush()
    frame = setup.captureCharFrame()
    expect(frame).toContain("› provider-b")
    expect(frame).toContain("Same model · provider-b")
    chosen = "project"
    await run("s")
    expect(query).toEqual({ directory: "/project", range: "last30" })
    chosen = "all"
    await run("t")
    expect(query).toEqual({ directory: "/project", range: "all" })

    // Partial records still contribute to each category they report, without zero-filling the rest.
    setState(previous => ({ ...previous, requests: [requests[0], { ...requests[0], tokens: { input: 12 } }], samples: [] }))
    setup.resize(100, 40)
    await setup.flush()
    frame = setup.captureCharFrame()
    expect(frame).toMatch(/Prompt\s+42 · fresh 22 \+ cached 20/)
    expect(frame).toMatch(/Generated\s+6 · output 5 \+ reasoning 1/)
    expect(frame).not.toContain("complete records")

    // No-data copy, header, help and detail must all fit when enough physical rows exist.
    // Read native geometry as well as characters, not an estimated string budget.
    for (const [width, height] of [[80, 26], [50, 34], [30, 55]] as const) {
      setup.resize(width, height)
      await setup.flush()
      const box = scrollbox(setup.renderer.root)!
      expect(box.scrollHeight).toBeLessThanOrEqual(box.viewport.height)
      frame = setup.captureCharFrame()
      expect(frame).toMatch(/Tokscope\s+· current\s+project/)
      expect(frame).toContain("unavailable.")
      expect(frame).toMatch(/reset\s+history\s+in\s+palette/)
      expect(frame).toContain("Req")
      expect(frame).toContain("Tok")
    }
    // When the complete detail cannot physically fit, it remains reachable via scrolling;
    // fixed chrome stays visible rather than pushing the footer outside the terminal.
    setup.resize(30, 18)
    await setup.flush()
    const box = scrollbox(setup.renderer.root)!
    expect(box.scrollHeight).toBeGreaterThan(box.viewport.height)
    box.scrollTo({ x: 0, y: Infinity })
    await setup.flush()
    frame = setup.captureCharFrame()
    expect(frame).toContain("unavailable.")
    expect(frame).toMatch(/reset\s+history\s+in\s+palette/)

    setState(previous => ({ ...previous, samples: [
      { providerID: "provider-a", modelID: "same", variant: "high", completedAt: now, rate: 20 },
    ] }))
    await setup.flush()
    box.scrollTo({ x: 0, y: Infinity })
    await setup.flush()
    frame = setup.captureCharFrame()
    expect(frame).toContain("20.0 tok/s")
    expect(frame).toMatch(/reset\s+history\s+in\s+palette/)
    expect(box.scrollWidth).toBeLessThanOrEqual(box.viewport.width)
  } finally {
    await setup.dispose()
  }
})
