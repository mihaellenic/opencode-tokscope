import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { DEFAULT_FILTERS, rangeStartMs, type Filters, type RangeFilter, type ScopeFilter } from "../filters"
import { formatCoverage, modelDisplayName } from "../format"
import type { HistoryService, ViewState } from "../history/service"
import { applyReasoningFilter, comparisonRows, dailySeries, type ReasoningFilter } from "../stats"
import { Header, rangeLabel, reasoningLabel } from "./header"
import { bannerMessage, footerStatusSuffix } from "./heading-status"
import { nextSelection } from "./selection"
import { pickViewPageState, type PageState } from "./state"
import { EmptyState, ErrorState, LoadingState, UnmeasurableState } from "./states"
import { ComparisonTable } from "./table"
import { TrendPanel } from "./trend"

const SCOPE_OPTIONS: { title: string; value: ScopeFilter }[] = [
  { title: "Current project", value: "project" },
  { title: "All projects", value: "all" },
]

const RANGE_OPTIONS: { title: string; value: RangeFilter }[] = [
  { title: "Last 7 days", value: "last7" },
  { title: "Last 30 days", value: "last30" },
  { title: "Last 90 days", value: "last90" },
  { title: "All history", value: "all" },
]

const HELP_LINE = "↑↓ select · enter trend · ←→ day · s scope · t range · r reasoning · esc back · ctrl+p reset history"

export function TokscopePage(props: {
  context: Plugin.Context
  service: HistoryService
  onClose: () => void
}) {
  const theme = props.context.theme
  const dimensions = useTerminalDimensions()

  void props.context.data.location.model.sync()
  void props.context.data.location.provider.sync()

  const [filters, setFilters] = createSignal<Filters>({ ...DEFAULT_FILTERS })
  const [selectedKey, setSelectedKey] = createSignal<string | undefined>(undefined)
  const [selectedDay, setSelectedDay] = createSignal(0)

  const directory = () =>
    props.context.location?.directory ?? props.context.data.location.default().directory

  /**
   * One reactive read of the shared cache for the current filters: filter changes, background
   * publications, and every timer tick of the plugin-lifetime hold all land here.
   */
  const state = (): ViewState =>
    props.service.view({
      directory: filters().scope === "project" ? directory() : undefined,
      range: filters().range,
    })()

  /** Trend windows advance with the last completed check rather than with page-open time. */
  const referenceNow = () => state().lastCheckedAt ?? Date.now()

  const filtered = createMemo(() =>
    applyReasoningFilter(state().samples, state().unavailable, filters().reasoning),
  )

  const pageState = createMemo<PageState>(() => pickViewPageState(state()))

  const rows = createMemo(() => comparisonRows(filtered().samples, filtered().unavailable))

  createEffect(() => {
    const list = rows()
    // Background publications must not steal the selection: only an absent row is re-selected.
    if (list.some((row) => row.key === selectedKey())) return
    setSelectedKey(list[0]?.key)
  })

  const moveSelection = (delta: number) =>
    setSelectedKey(
      nextSelection(
        rows().map((row) => row.key),
        selectedKey(),
        delta,
      ),
    )

  const selectedRow = createMemo(() => rows().find((row) => row.key === selectedKey()))

  const series = createMemo(() => {
    const key = selectedKey()
    if (key === undefined) return []
    const nowMs = referenceNow()
    return dailySeries(filtered().samples, key, rangeStartMs(filters().range, nowMs), nowMs)
  })

  createEffect(() => {
    selectedKey()
    const points = series()
    const last = points.findLastIndex((point) => point.calls > 0)
    setSelectedDay(last === -1 ? Math.max(0, points.length - 1) : last)
  })

  const moveDay = (delta: number) =>
    setSelectedDay((current) => Math.max(0, Math.min(current + delta, Math.max(0, series().length - 1))))

  const rowLabel = () => {
    const row = selectedRow()
    if (row === undefined) return "No row selected"
    const name = modelDisplayName(
      props.context.data.location.model.list(),
      row.providerID,
      row.modelID,
    )
    const provider =
      props.context.data.location.provider.list()?.find((item) => item.id === row.providerID)?.name ??
      row.providerID
    return `${name} · ${provider}`
  }

  const reasoningOptions = () => {
    const options: { title: string; value: ReasoningFilter }[] = [{ title: "All settings", value: "all" }]
    const value = state()
    for (const variant of value.variants) options.push({ title: variant, value: variant })
    const hasUnknown = [...value.samples, ...value.unavailable].some((item) => item.variant === undefined)
    if (hasUnknown) options.push({ title: "unknown", value: "unknown" })
    return options
  }

  const pickScope = async () => {
    const chosen = await props.context.ui.dialog.select<ScopeFilter>({
      title: "Scope",
      current: filters().scope,
      options: SCOPE_OPTIONS,
    })
    if (chosen !== undefined) setFilters((previous) => ({ ...previous, scope: chosen }))
  }

  const pickRange = async () => {
    const chosen = await props.context.ui.dialog.select<RangeFilter>({
      title: "Time range",
      current: filters().range,
      options: RANGE_OPTIONS,
    })
    if (chosen !== undefined) setFilters((previous) => ({ ...previous, range: chosen }))
  }

  const pickReasoning = async () => {
    const chosen = await props.context.ui.dialog.select<ReasoningFilter>({
      title: "Reasoning setting",
      current: filters().reasoning,
      options: reasoningOptions(),
    })
    if (chosen !== undefined) setFilters((previous) => ({ ...previous, reasoning: chosen }))
  }

  props.context.keymap.layer(() => ({
    commands: [
      { bind: "escape", title: "back", run: props.onClose },
      { bind: "up", title: "previous row", run: () => moveSelection(-1) },
      { bind: "down", title: "next row", run: () => moveSelection(1) },
      { bind: "k", title: "previous row", run: () => moveSelection(-1) },
      { bind: "j", title: "next row", run: () => moveSelection(1) },
      { bind: "left", title: "previous day", run: () => moveDay(-1) },
      { bind: "right", title: "next day", run: () => moveDay(1) },
      { bind: "s", title: "scope", run: pickScope },
      { bind: "t", title: "time range", run: pickRange },
      { bind: "r", title: "reasoning", run: pickReasoning },
      {
        bind: "enter",
        title: "retry",
        run: () => {
          // A failed refresh over retained rows keeps the cache on screen; both are retryable.
          if (state().kind === "error") props.service.refreshNow()
        },
      },
    ],
  }))

  const coverage = () =>
    pageState() === "loading"
      ? ""
      : `  ·  ${formatCoverage(filtered().samples.length, filtered().unavailable.length)}`

  return (
    <box
      width="100%"
      height="100%"
      backgroundColor={theme.background.base}
      flexDirection="column"
      padding={1}
      gap={1}
    >
      <Header context={props.context} filters={filters()} />

      <Show when={bannerMessage(state())}>
        {(message) => (
          <text fg={state().kind === "error" ? theme.text.feedback.error.base : theme.text.muted}>
            {message()}
          </text>
        )}
      </Show>

      <box flexGrow={1} flexDirection="column" gap={1}>
        <Switch>
          <Match when={pageState() === "loading"}>
            <LoadingState context={props.context} sessions={state().scanned} />
          </Match>
          <Match when={pageState() === "error"}>
            <ErrorState context={props.context} />
          </Match>
          <Match when={pageState() === "empty"}>
            <EmptyState context={props.context} filters={filters()} />
          </Match>
          <Match when={pageState() === "unmeasurable"}>
            <UnmeasurableState context={props.context} />
          </Match>
          <Match when={pageState() === "ready"}>
            <box flexDirection="column" flexGrow={1} gap={1}>
              <ComparisonTable
                context={props.context}
                rows={rows()}
                selectedKey={selectedKey()}
                width={Math.max(20, dimensions().width - 2)}
                height={Math.max(3, dimensions().height - 27)}
              />
              <TrendPanel
                context={props.context}
                series={series()}
                selectedDay={selectedDay()}
                rowLabel={rowLabel()}
                rangeLabel={rangeLabel(filters().range)}
                reasoningLabel={reasoningLabel(filters().reasoning)}
                width={Math.max(20, dimensions().width - 2)}
              />
            </box>
          </Match>
        </Switch>
      </box>

      <text fg={theme.text.muted}>{HELP_LINE + coverage() + footerStatusSuffix(state())}</text>
    </box>
  )
}
