import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { HistoryService, WidgetSharedState } from "../src/history/service"
import type { WidgetRow } from "../src/sidebar/rank"
import { createWidgetStore } from "../src/sidebar/store"

const ROWS: WidgetRow[] = [{ key: "p/m", providerID: "p", modelID: "m", median: 40, calls: 3 }]
const LOADING: WidgetSharedState = { status: "loading", rows: [], stale: false }

/** Minimal stand-in for the shared service: the widget only reads its accessor and holds it. */
function fakeService(initial: WidgetSharedState = LOADING) {
  const [widget, setWidget] = createSignal<WidgetSharedState>(initial)
  let holds = 0
  let refreshes = 0
  let onRefresh: (() => void) | undefined

  const service: HistoryService = {
    view: () => () => {
      throw new Error("the widget store never opens a view")
    },
    widget: () => widget,
    hold: () => {
      holds += 1
      let released = false
      return () => {
        if (released) return
        released = true
        holds -= 1
      }
    },
    refreshNow: () => {
      refreshes += 1
      onRefresh?.()
    },
    reset: async () => {},
  }

  return {
    service,
    publish: setWidget,
    current: widget,
    holds: () => holds,
    refreshes: () => refreshes,
    /** Simulates the service publishing the outcome of a refresh on its own schedule. */
    respondToRefresh: (handler: () => void) => {
      onRefresh = handler
    },
  }
}

describe("createWidgetStore", () => {
  test("passes the service's loading state through until its first publish", () => {
    const fake = fakeService()
    const store = createWidgetStore(fake.service)

    expect(store.state()).toEqual({ status: "loading", rows: [], stale: false })

    fake.publish({ status: "ready", rows: ROWS, stale: false })

    expect(store.state()).toEqual({ status: "ready", rows: ROWS, stale: false })
  })

  test("forwards the service's rows unchanged", () => {
    const fake = fakeService({ status: "ready", rows: ROWS, stale: false })
    const store = createWidgetStore(fake.service)

    expect(store.state().rows).toBe(ROWS)
    expect(store.state()).toBe(fake.current())
  })

  test("reports the service's stale flag after a failed refresh", () => {
    const fake = fakeService({ status: "ready", rows: ROWS, stale: false })
    const store = createWidgetStore(fake.service)
    fake.respondToRefresh(() => fake.publish({ status: "ready", rows: ROWS, stale: true }))

    store.refresh()

    expect(store.state()).toEqual({ status: "ready", rows: ROWS, stale: true })
  })

  test("refresh asks the service to refresh", () => {
    const fake = fakeService({ status: "ready", rows: ROWS, stale: false })
    const store = createWidgetStore(fake.service)

    store.refresh()

    expect(fake.refreshes()).toBe(1)
  })

  test("attach holds the service until cleanup releases it", () => {
    const fake = fakeService()
    const store = createWidgetStore(fake.service)

    const detach = store.attach()

    expect(fake.holds()).toBe(1)

    detach()

    expect(fake.holds()).toBe(0)
  })
})
