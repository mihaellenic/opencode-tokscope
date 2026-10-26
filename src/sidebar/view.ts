import { entryLines, headingLine, type WidgetEntry } from "./layout"
import type { WidgetState } from "./store"

export interface WidgetView {
  heading: string[]
  /** Nothing to show yet and acquisition is still pending: render the spinner. */
  pending: boolean
  lines: string[]
}

/**
 * Rows outrank the service status, so retained results stay on screen through refreshes and failures
 * without stale or error labels. Only a pending view with nothing to show spins; a settled or failed
 * empty view falls back to the normal empty message.
 */
export function widgetView(
  state: WidgetState,
  width: number | undefined,
  entries: readonly WidgetEntry[],
): WidgetView | undefined {
  if (width === undefined) return undefined
  const hasRows = state.rows.length > 0
  return {
    heading: headingLine(width),
    pending: !hasRows && state.status === "loading",
    lines: hasRows ? entryLines(entries, width) : [],
  }
}
