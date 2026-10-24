import { TextAttributes, type BoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { modelDisplayName } from "../format"
import {
  HEADING_BRAND,
  LOADING_MESSAGE,
  NO_QUALIFYING_MESSAGE,
  READ_ERROR_MESSAGE,
  type WidgetEntry,
} from "./layout"
import type { WidgetStore } from "./store"
import { widgetView } from "./view"

const MEASURE_TICKS = 10

export function TokscopeSidebar(props: {
  context: Plugin.Context
  store: WidgetStore
  open: () => void
}): JSX.Element {
  const theme = props.context.theme
  const dimensions = useTerminalDimensions()
  const [width, setWidth] = createSignal<number>()

  let target: BoxRenderable | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const measure = (remaining = MEASURE_TICKS) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (target === undefined) return
      let measured = 0
      try {
        measured = target.getLayout().width
      } catch {
        return
      }
      if (measured > 0) {
        setWidth(measured)
        return
      }
      if (remaining > 1) measure(remaining - 1)
    }, 0)
  }

  createEffect(() => {
    dimensions()
    measure()
  })

  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })

  onMount(() => {
    void props.context.data.location.model.sync()
    void props.context.data.location.provider.sync()
    const detach = props.store.attach()
    onCleanup(detach)
  })

  const entries = createMemo<WidgetEntry[]>(() => {
    const models = props.context.data.location.model.list()
    const providers = props.context.data.location.provider.list()
    return props.store.state().rows.map((row) => ({
      model: modelDisplayName(models, row.providerID, row.modelID),
      provider: providers?.find((item) => item.id === row.providerID)?.name ?? row.providerID,
      median: row.median,
    }))
  })

  const view = () => widgetView(props.store.state(), width(), entries())

  return (
    <box
      ref={(element) => {
        target = element
        measure()
      }}
      flexDirection="column"
      width="100%"
      onMouseDown={props.open}
    >
      <Show when={view()} keyed>
        {(current) => (
          <>
            <For each={current.heading}>
              {(line, index) =>
                index() === 0 ? (
                  <box flexDirection="row">
                    <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                      {line.slice(0, HEADING_BRAND.length)}
                    </text>
                    <text fg={theme.text.muted}>{line.slice(HEADING_BRAND.length)}</text>
                  </box>
                ) : (
                  <text fg={theme.text.muted}>{line}</text>
                )
              }
            </For>

            <Show when={current.status === "loading"}>
              <text fg={theme.text.muted}>{LOADING_MESSAGE}</text>
            </Show>
            <Show when={current.status === "error"}>
              <text fg={theme.text.feedback.error.base}>{READ_ERROR_MESSAGE}</text>
            </Show>
            <Show when={current.status === "ready"}>
              <Show
                when={current.lines.length > 0}
                fallback={<text fg={theme.text.muted}>{NO_QUALIFYING_MESSAGE}</text>}
              >
                <For each={current.lines.map((text, index) => ({ index, text }))}>
                  {(line) => <text fg={theme.text.muted}>{line.text}</text>}
                </For>
              </Show>
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}
