import type { Plugin } from "@opencode/plugin/tui"
import { For, Show, createMemo } from "solid-js"
import type { ModelRow } from "../stats"
import { detailContent, type RowLabels } from "./layout"

export function DetailPanel(props: {
  context: Plugin.Context
  row: ModelRow
  labels: RowLabels
  width: number
}) {
  const theme = props.context.theme
  const content = createMemo(() => detailContent(props.row, props.labels, props.width))

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={content().lines}>
        {(line, index) => (
          <text fg={theme.text.base} selectable={false}>
            <Show when={content().reuseBar?.lineIndex === index() ? content().reuseBar : undefined} fallback={line}>
              {bar => (
                <>
                  {bar().label}
                  <span style={{ fg: theme.text.base }}>{bar().filled}</span>
                  <span style={{ fg: theme.text.muted }}>{bar().empty}</span>
                </>
              )}
            </Show>
          </text>
        )}
      </For>
    </box>
  )
}
