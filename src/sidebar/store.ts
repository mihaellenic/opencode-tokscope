import type { HistoryService } from "../history/service"
import type { WidgetRow } from "./rank"

export type WidgetStatus = "loading" | "ready" | "error"

export interface WidgetState {
  status: WidgetStatus
  rows: WidgetRow[]
  stale: boolean
}

export interface WidgetStore {
  state(): WidgetState
  refresh(): void
  attach(): () => void
}

/**
 * Sidebar adapter over the shared history service: the service owns acquisition, rolling-window
 * expiry, and refresh coalescing, so the widget only mirrors its publication and holds it open.
 */
export function createWidgetStore(service: HistoryService): WidgetStore {
  return {
    state: () => service.widget()(),
    refresh: () => service.refreshNow(),
    attach: () => service.hold(),
  }
}
