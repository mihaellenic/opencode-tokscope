import type { Plugin } from "@opencode/plugin/tui"
import type { Filters } from "../filters"
import { rangeLabel, scopeLabel } from "./header"

export function EmptyState(props: { context: Plugin.Context; filters: Filters }) {
  const theme = props.context.theme
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text.muted}>
        {`No history in ${scopeLabel(props.filters.scope)} · ${rangeLabel(props.filters.range)}.`}
      </text>
      <text fg={theme.text.muted}>Try a wider time range or all projects.</text>
    </box>
  )
}
