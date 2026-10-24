import { createSignal } from "solid-js"
import { collectMeasurements, type HarvestClient } from "../harvest"
import { WIDGET_WINDOW_MS, widgetRows, type WidgetRow } from "./rank"

export const WIDGET_REFRESH_MS = 60_000

export type WidgetStatus = "loading" | "ready" | "error"

export interface WidgetState {
  status: WidgetStatus
  rows: WidgetRow[]
  stale: boolean
}

export interface WidgetStoreDeps {
  client: HarvestClient
  onEvent: (handler: () => void) => () => void
  setTimer: (callback: () => void, ms: number) => () => void
  now: () => number
}

export interface WidgetStore {
  state(): WidgetState
  refresh(): Promise<void>
  attach(): () => void
}

export function createWidgetStore(deps: WidgetStoreDeps): WidgetStore {
  const [state, setState] = createSignal<WidgetState>({ status: "loading", rows: [], stale: false })

  let inFlight = false
  let pending = false
  let resolvers: (() => void)[] = []

  async function runOnce(): Promise<void> {
    const nowMs = deps.now()
    try {
      const result = await collectMeasurements(deps.client, { fromMs: nowMs - WIDGET_WINDOW_MS })
      setState({ status: "ready", rows: widgetRows(result.samples, nowMs), stale: false })
    } catch {
      const previous = state()
      setState(
        previous.rows.length > 0
          ? { status: "ready", rows: previous.rows, stale: true }
          : { status: "error", rows: [], stale: false },
      )
    }
  }

  async function drain(): Promise<void> {
    inFlight = true
    do {
      pending = false
      await runOnce()
    } while (pending)
    inFlight = false

    const waiting = resolvers
    resolvers = []
    for (const resolve of waiting) resolve()
  }

  function refresh(): Promise<void> {
    return new Promise((resolve) => {
      resolvers.push(resolve)
      if (inFlight) {
        pending = true
        return
      }
      void drain()
    })
  }

  function attach(): () => void {
    const detachEvent = deps.onEvent(() => void refresh())
    const detachTimer = deps.setTimer(() => void refresh(), WIDGET_REFRESH_MS)
    void refresh()

    return () => {
      detachEvent()
      detachTimer()
    }
  }

  return { state, refresh, attach }
}
