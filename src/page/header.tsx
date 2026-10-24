import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { Filters, RangeFilter, ScopeFilter } from "../filters"
import type { ReasoningFilter } from "../stats"

export function scopeLabel(scope: ScopeFilter): string {
  return scope === "project" ? "current project" : "all projects"
}

export function rangeLabel(range: RangeFilter): string {
  switch (range) {
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

export function reasoningLabel(reasoning: ReasoningFilter): string {
  if (reasoning === "all") return "all settings"
  if (reasoning === "unknown") return "unknown"
  return reasoning
}

export function Header(props: { context: Plugin.Context; filters: Filters }) {
  const theme = props.context.theme
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
        Tokscope
      </text>
      <text fg={theme.text.muted}>
        · {scopeLabel(props.filters.scope)} · {rangeLabel(props.filters.range)} · reasoning:{" "}
        {reasoningLabel(props.filters.reasoning)}
      </text>
    </box>
  )
}
