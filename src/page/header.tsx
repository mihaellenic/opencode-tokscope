import type { Plugin } from "@opencode/plugin/tui"
import type { Filters, RangeFilter, ScopeFilter } from "../filters"

export function scopeLabel(scope: ScopeFilter): string {
  return scope === "project" ? "current project" : "all projects"
}

export function rangeLabel(range: RangeFilter): string {
  switch (range) {
    case "today":
      return "today"
    case "last7":
      return "last 7 days"
    case "last30":
      return "last 30 days"
    case "last90":
      return "last 90 days"
    case "all":
      return "all history"
  }
}

/** Each filter is followed by the key that changes it. */
export function Header(props: { context: Plugin.Context; filters: Filters }) {
  const theme = props.context.theme
  return (
    <text fg={theme.text.muted} flexShrink={0}>
      <b style={{ fg: theme.text.base }}>Tokscope</b>
      {` · ${scopeLabel(props.filters.scope)} (s) · ${rangeLabel(props.filters.range)} (t)`}
    </text>
  )
}
