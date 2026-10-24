import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { For, Show } from "solid-js"
import { formatRate, modelDisplayName } from "../format"
import type { ComparisonRow } from "../stats"
import { windowRange } from "./selection"

const MARKER_WIDTH = 2
const PROVIDER_WIDTH = 18
const MEDIAN_WIDTH = 13
const CALLS_WIDTH = 5
const GAP = 2

function pad(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width)
  return value.slice(0, Math.max(1, width - 1)) + "…"
}

export function ComparisonTable(props: {
  context: Plugin.Context
  rows: readonly ComparisonRow[]
  selectedKey: string | undefined
  width: number
  height: number
}) {
  const theme = props.context.theme
  const showProvider = () => props.width >= 60
  const modelWidth = () =>
    Math.max(
      12,
      props.width -
        MARKER_WIDTH -
        MEDIAN_WIDTH -
        CALLS_WIDTH -
        GAP * (showProvider() ? 3 : 2) -
        (showProvider() ? PROVIDER_WIDTH : 0),
    )

  const models = () => props.context.data.location.model.list()
  const providers = () => props.context.data.location.provider.list()
  const modelName = (row: ComparisonRow) => modelDisplayName(models(), row.providerID, row.modelID)
  const providerName = (row: ComparisonRow) =>
    providers()?.find((provider) => provider.id === row.providerID)?.name ?? row.providerID

  const selectedIndex = () =>
    Math.max(
      0,
      props.rows.findIndex((row) => row.key === props.selectedKey),
    )
  const visible = () => {
    const window = windowRange(props.rows.length, selectedIndex(), Math.max(1, props.height))
    return props.rows.slice(window.start, window.end)
  }

  const line = (row: ComparisonRow, selected: boolean) => {
    const median = row.unavailable || row.median === null ? "unavailable" : formatRate(row.median)
    const cells = [
      pad(modelName(row), modelWidth()),
      ...(showProvider() ? [pad(providerName(row), PROVIDER_WIDTH)] : []),
      pad(median, MEDIAN_WIDTH),
      pad(String(row.calls), CALLS_WIDTH),
    ]
    return `${selected ? "› " : "  "}${cells.join(" ".repeat(GAP))}`
  }

  const header = () => {
    const cells = [
      pad("Model", modelWidth()),
      ...(showProvider() ? [pad("Provider", PROVIDER_WIDTH)] : []),
      pad("Median tok/s", MEDIAN_WIDTH),
      pad("Calls", CALLS_WIDTH),
    ]
    return `  ${cells.join(" ".repeat(GAP))}`
  }

  return (
    <box flexDirection="column">
      <text fg={theme.text.muted} attributes={TextAttributes.BOLD}>
        {header()}
      </text>
      <For each={visible()}>
        {(row) => (
          <text
            fg={row.key === props.selectedKey ? theme.text.base : theme.text.muted}
            attributes={row.key === props.selectedKey ? TextAttributes.BOLD : undefined}
            selectable={false}
          >
            {line(row, row.key === props.selectedKey)}
          </text>
        )}
      </For>
      <Show when={props.rows.length > visible().length}>
        <text fg={theme.text.muted}>
          {`  … ${props.rows.length - visible().length} more rows`}
        </text>
      </Show>
    </box>
  )
}
