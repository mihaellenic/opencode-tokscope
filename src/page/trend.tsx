import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { For, Show, createMemo } from "solid-js"
import { formatDayLabel } from "../format"
import { barLevels, dayWindow, type DayPoint } from "../stats"
import { PLOT_ROWS, axisLine, barChar } from "./chart"

export function TrendPanel(props: {
  context: Plugin.Context
  series: readonly DayPoint[]
  selectedDay: number
  rowLabel: string
  rangeLabel: string
  reasoningLabel: string
  width: number
}) {
  const theme = props.context.theme
  const columns = () => Math.max(1, Math.floor((props.width - 16) / 2))
  const window = createMemo(() => dayWindow(props.series, props.selectedDay, columns()))
  const visible = createMemo(() => props.series.slice(window().start, window().end))
  const levels = createMemo(() => barLevels(visible(), PLOT_ROWS))
  const selectedIndex = () =>
    Math.max(0, Math.min(props.selectedDay - window().start, Math.max(0, visible().length - 1)))
  const plotRows = () => Array.from({ length: PLOT_ROWS }, (_, index) => PLOT_ROWS - 1 - index)
  const measurable = () => props.series.some((point) => point.median !== null)

  const detail = () => {
    const point = props.series[props.selectedDay]
    if (point === undefined) return "no measured calls"
    if (point.median === null) return `${formatDayLabel(point.date)} · no measured calls`
    return `${formatDayLabel(point.date)} · ${point.median.toFixed(1)} tok/s · ${point.calls} calls`
  }

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text.muted} attributes={TextAttributes.BOLD}>
        {`Trend: ${props.rowLabel} · ${props.rangeLabel} · ${props.reasoningLabel}`}
      </text>
      <Show
        when={measurable()}
        fallback={
          <text fg={theme.text.muted}>
            No measurable trend for this model — historical timing or token data is unavailable.
          </text>
        }
      >
        <box flexDirection="column">
          <For each={plotRows()}>
            {(row) => (
              <box flexDirection="row">
                <For each={visible()}>
                  {(_, index) => (
                    <text
                      fg={index() === selectedIndex() ? theme.text.base : theme.text.muted}
                      selectable={false}
                    >
                      {barChar(levels()[index()], row, PLOT_ROWS) + " "}
                    </text>
                  )}
                </For>
              </box>
            )}
          </For>
          <text fg={theme.text.muted}>{axisLine(visible(), selectedIndex())}</text>
        </box>
        <text fg={theme.text.base}>{detail()}</text>
      </Show>
    </box>
  )
}
