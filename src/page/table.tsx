import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { For, Show, createMemo } from "solid-js"
import type { ModelRow } from "../stats"
import { tableLayout, tableLines, type RowLabels } from "./layout"
import { windowRange } from "./selection"

export function ModelTable(props: {
  context: Plugin.Context
  rows: readonly ModelRow[]
  labels: (row: ModelRow) => RowLabels
  selectedKey: string | undefined
  width: number
  /** Total line budget, including header and the optional window hint. */
  height: number
}) {
  const theme = props.context.theme
  const visible = createMemo(() => {
    const size = Math.max(1, props.height - 1 - (props.rows.length > props.height - 1 ? 1 : 0))
    const selected = Math.max(0, props.rows.findIndex(row => row.key === props.selectedKey))
    const window = windowRange(props.rows.length, selected, size)
    return props.rows.slice(window.start, window.end)
  })
  const lines = createMemo(() => tableLines(visible(), row => {
    const labels = props.labels(row)
    const duplicate = !tableLayout(props.width).showProvider && props.rows.some(other =>
      other.providerID !== row.providerID && props.labels(other).name === labels.name)
    return { ...labels, name: duplicate ? `${labels.provider} · ${labels.name}` : labels.name }
  }, props.selectedKey, props.width))

  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.text.muted} attributes={TextAttributes.BOLD}>{lines().header}</text>
      <For each={lines().lines}>
        {(line, index) => (
          <text
            fg={visible()[index()]?.key === props.selectedKey ? theme.text.base : theme.text.muted}
            attributes={visible()[index()]?.key === props.selectedKey ? TextAttributes.BOLD : undefined}
            selectable={false}
          >{line}</text>
        )}
      </For>
      <Show when={props.rows.length > visible().length}>
        <text fg={theme.text.muted}>{`  … ${props.rows.length - visible().length} more rows`}</text>
      </Show>
    </box>
  )
}
