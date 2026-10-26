import type { Plugin } from "@opencode/plugin/tui"
import type { Filters } from "../filters"
import { rangeLabel, reasoningLabel, scopeLabel } from "./header"

export function EmptyState(props: { context: Plugin.Context; filters: Filters }) {
  const theme = props.context.theme
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text.muted}>
        {`No history in ${scopeLabel(props.filters.scope)} · ${rangeLabel(props.filters.range)} · reasoning: ${reasoningLabel(props.filters.reasoning)}.`}
      </text>
      <text fg={theme.text.muted}>Try a wider time range or all projects.</text>
    </box>
  )
}

export function UnmeasurableState(props: { context: Plugin.Context }) {
  const theme = props.context.theme
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text.muted}>History exists, but none of it is measurable.</text>
      <text fg={theme.text.muted}>
        Completed requests are missing the historical timing or token data needed for speed.
      </text>
    </box>
  )
}
