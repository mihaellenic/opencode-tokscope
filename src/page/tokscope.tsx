import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { DEFAULT_FILTERS, rangeStartMs, type Filters, type RangeFilter, type ScopeFilter } from "../filters"
import { modelDisplayName } from "../format"
import type { HistoryService, ViewState } from "../history/service"
import { Spinner } from "../spinner"
import { modelRows, dailySeries, type ModelRow } from "../stats"
import { Header } from "./header"
import { DetailPanel } from "./detail"
import { HELP_LINE } from "./help"
import { nextSelection } from "./selection"
import { pickViewPageState, type PageState } from "./state"
import { EmptyState } from "./states"
import { ModelTable } from "./table"
import { TrendPanel } from "./trend"

const SCOPE_OPTIONS: { title: string; value: ScopeFilter }[] = [
  { title: "Current project", value: "project" },
  { title: "All projects", value: "all" },
]

const RANGE_OPTIONS: { title: string; value: RangeFilter }[] = [
  { title: "Today", value: "today" },
  { title: "Last 7 days", value: "last7" },
  { title: "Last 30 days", value: "last30" },
  { title: "Last 90 days", value: "last90" },
  { title: "All history", value: "all" },
]

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

  const pageState = createMemo<PageState>(() => pickViewPageState(state()))

  const rows = createMemo(() => modelRows(state().requests, state().samples))

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
    return dailySeries(state().samples, key, rangeStartMs(filters().range, nowMs), nowMs)
  })

  /** The row key the current day anchor belongs to; a change re-anchors, a publication does not. */
  let anchoredKey: string | undefined

  createEffect(() => {
    const key = selectedKey()
    const points = series()
    const current = selectedDay()
    // Background publications must not steal the day: only a changed row or a day index that fell
    // out of the (possibly shorter) series re-anchors; an unchanged row keeps its day.
    if (key === anchoredKey && current < points.length) return
    const last = points.findLastIndex((point) => point.calls > 0)
    setSelectedDay(last === -1 ? Math.max(0, points.length - 1) : last)
    anchoredKey = key
  })

  const moveDay = (delta: number) =>
    setSelectedDay((current) => Math.max(0, Math.min(current + delta, Math.max(0, series().length - 1))))

  const rowLabels = (row: ModelRow) => {
    const name = modelDisplayName(
      props.context.data.location.model.list(),
      row.providerID,
      row.modelID,
    )
    const provider =
      props.context.data.location.provider.list()?.find((item) => item.id === row.providerID)?.name ??
      row.providerID
    return { name, provider }
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
    ],
  }))

  let scroll!: ScrollBoxRenderable
  const [viewport, setViewport] = createSignal({ width: 0, height: 0 })
  const [detailHeight, setDetailHeight] = createSignal(0)
  const [trendHeight, setTrendHeight] = createSignal(0)
  // Keep one gutter cell even while the automatic scrollbar is hidden: wrapping stays stable.
  const width = () => Math.max(1, Math.min(viewport().width || Infinity, dimensions().width - 3))
  // Native measurements include wrapped labels/no-data copy and the actual header/help height.
  const tableHeight = () => Math.max(3, viewport().height - detailHeight() - trendHeight() - 2)

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

      <scrollbox
        ref={scroll}
        flexGrow={1}
        minHeight={0}
        scrollX={false}
        focused={false}
        verticalScrollbarOptions={{ width: 1 }}
        viewportOptions={{ onSizeChange() {
          setViewport({ width: scroll.viewport.width, height: scroll.viewport.height })
        } }}
      >
        <Switch>
          <Match when={pageState() === "loading"}>
            <Spinner context={props.context} />
          </Match>
          <Match when={pageState() === "empty"}>
            <EmptyState context={props.context} filters={filters()} />
          </Match>
          <Match when={pageState() === "ready"}>
            <box width={width()} flexDirection="column" gap={1} flexShrink={0}>
              <ModelTable
                context={props.context}
                rows={rows()}
                labels={rowLabels}
                selectedKey={selectedKey()}
                width={width()}
                height={tableHeight()}
              />
              <box flexDirection="column" flexShrink={0} onSizeChange={function () { setDetailHeight(this.height) }}>
                <Show when={selectedRow()}>
                  {row => <DetailPanel context={props.context} row={row()} labels={rowLabels(row())} width={width()} />}
                </Show>
              </box>
              <box flexDirection="column" flexShrink={0} onSizeChange={function () { setTrendHeight(this.height) }}>
                <TrendPanel
                  context={props.context}
                  series={series()}
                  selectedDay={selectedDay()}
                  width={width()}
                />
              </box>
            </box>
          </Match>
        </Switch>
      </scrollbox>

      <text fg={theme.text.muted} flexShrink={0}>{HELP_LINE}</text>
    </box>
  )
}
