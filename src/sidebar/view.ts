import { entryLines, headingLine, headingTitle, type WidgetEntry } from "./layout"
import type { WidgetState } from "./store"

export interface WidgetView {
  title: string
  heading: string[]
  status: WidgetState["status"]
  lines: string[]
}

export function widgetView(
  state: WidgetState,
  width: number | undefined,
  entries: readonly WidgetEntry[],
): WidgetView | undefined {
  if (width === undefined) return undefined
  return {
    title: headingTitle(state.stale),
    heading: headingLine(width, state.stale),
    status: state.status,
    lines: state.status === "ready" ? entryLines(entries, width) : [],
  }
}
