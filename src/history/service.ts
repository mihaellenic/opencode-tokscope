import { createSignal, type Accessor, type Setter } from "solid-js"
import { rangeStartMs, type RangeFilter } from "../filters"
import {
  collectVariants,
  inRangeSamples,
  listSessions,
  scanMessages,
  type HarvestClient,
  type SessionMeta,
} from "../harvest"
import type { Sample, UnavailableSample } from "../metric"
import { widgetRows, type WidgetRow } from "../sidebar/rank"
import { comparisonRows } from "../stats"
import type { HistoryRepository } from "./durable"
import {
  CACHE_SCHEMA_VERSION,
  METRIC_VERSION,
  recordFrom,
  signatureFor,
  type CoverageRecord,
  type SessionIndexEntry,
  type SessionRecord,
  type ViewSnapshot,
} from "./records"

/** Reserved for the scheduling layer: per-burst event coalescing window. */
export const DIRTY_DEBOUNCE_MS = 250
/** Reserved for the scheduling layer: hard bound on how long a burst may defer work. */
export const MAX_SCHEDULE_DELAY_MS = 1_000
/** Minimum gap between two progressive publications. */
export const PUBLISH_INTERVAL_MS = 250
/** Background catch-up interval: the repeating timer tick while a consumer holds the service. */
export const RECENT_CATCHUP_MS = 60_000
/** A full inventory is repeated at least this often; catch-up listings cover the time in between. */
export const INVENTORY_MIN_INTERVAL_MS = 600_000
/** Reserved for the scheduling layer: audit rotation interval. */
export const AUDIT_INTERVAL_MS = 60_000
/** Reserved for the scheduling layer: sessions re-scanned per audit tick. */
export const AUDIT_BATCH_SESSIONS = 20
/** Number of view snapshots the repository keeps, newest last. */
export const SNAPSHOT_LIMIT = 8

export interface ViewState {
  kind: "loading" | "partial" | "cached" | "ready" | "error"
  samples: Sample[]
  unavailable: UnavailableSample[]
  variants: string[]
  scanned: number
  lastCheckedAt: number | undefined
  refreshing: boolean
  refreshFailed: boolean
  persistence: "ok" | "unavailable"
}

export interface WidgetSharedState {
  status: "loading" | "ready" | "error"
  rows: WidgetRow[]
  stale: boolean
}

export interface ViewRequest {
  directory: string | undefined
  range: RangeFilter
}

export interface HistoryService {
  view(request: ViewRequest): () => ViewState
  widget(): () => WidgetSharedState
  hold(): () => void
  refreshNow(): void
  reset(): Promise<void>
}

/** `HarvestClient` declares listing only; the installed client also serves `session.get`. */
type MetadataClient = HarvestClient & {
  session: HarvestClient["session"] & {
    get?: (input: { sessionID: string }) => Promise<SessionMeta>
  }
}

interface ViewEntry {
  request: ViewRequest
  accessor: Accessor<ViewState>
  publish: Setter<ViewState>
  lastCheckedAt: number | undefined
}

/** One listing pass per directory filter at a time; a second request coalesces into one follow-up. */
interface PassSlot {
  inFlight: boolean
  queued: boolean
}

interface DirectoryStatus {
  refreshing: boolean
  failed: boolean
}

interface ScanOutcome {
  /** Metadata as of the post-scan re-read: what the next listing pass will diff against. */
  meta: SessionMeta
  /** The metadata moved while the messages were read, so the session is scanned once more. */
  requeue: boolean
}

const viewKeyOf = (request: ViewRequest): string => JSON.stringify([request.directory, request.range])
const directoryKeyOf = (directory: string | undefined): string => JSON.stringify(directory ?? null)

/**
 * Sessions without a recorded directory stay visible in every project scope, which is exactly how
 * `collectMeasurements` has always filtered them.
 */
function matchesScope(sessionDirectory: string | undefined, directoryFilter: string | undefined): boolean {
  if (directoryFilter === undefined) return true
  return sessionDirectory === undefined || sessionDirectory === directoryFilter
}

/**
 * Shared, Solid-reactive history cache: one durable namespace and one acquisition pipeline for every
 * server and view. Signals are created without a component owner, so consumers only read accessors.
 *
 * `setTimer` is the repeating background tick (catch-up, and later audit); `delay` is the one-shot
 * timer that spaces progressive publications. `subscribeEvents` is consumed by the scheduling layer;
 * this module acquires, publishes, and reports failures only.
 */
export function createHistoryService(deps: {
  client: HarvestClient
  repository: HistoryRepository
  subscribeEvents: (handler: (event: { type: string; data?: { sessionID?: string } }) => void) => () => void
  setTimer: (callback: () => void, ms: number) => () => void
  delay: (callback: () => void, ms: number) => () => void
  now: () => number
  concurrency?: number
}): HistoryService {
  const client: MetadataClient = deps.client
  const now = deps.now
  const concurrency = Math.max(1, deps.concurrency ?? 8)

  const records = new Map<string, SessionRecord>()
  const index = new Map<string, SessionIndexEntry>()
  const tombstones = new Set<string>()
  const coverage = new Map<string, CoverageRecord>()
  const views = new Map<string, ViewEntry>()
  const passes = new Map<string, PassSlot>()
  const statuses = new Map<string, DirectoryStatus>()

  let holds = 0
  let timerCancel: (() => void) | undefined
  let publishCancel: (() => void) | undefined
  let lastPublishedAt: number | undefined
  let pendingRecords: SessionRecord[] = []
  let persistence: "ok" | "unavailable" = "ok"
  let widgetPublished = false

  const storedWidget = deps.repository.readWidgetSnapshot()
  const [widgetState, setWidgetState] = createSignal<WidgetSharedState>(
    storedWidget === undefined
      ? { status: "loading", rows: [], stale: false }
      : { status: "ready", rows: storedWidget.rows, stale: true },
  )
  if (storedWidget !== undefined) widgetPublished = true

  rememberTombstones()
  for (const shard of deps.repository.loadAllShards().values()) {
    for (const entry of Object.values(shard.index)) {
      if (!tombstones.has(entry.sessionID)) index.set(entry.sessionID, entry)
    }
    for (const record of Object.values(shard.records)) {
      if (!tombstones.has(record.sessionID)) records.set(record.sessionID, record)
    }
  }

  function rememberTombstones(): void {
    for (const sessionID of deps.repository.loadTombstones().sessionIDs) tombstones.add(sessionID)
  }

  /** Drops an in-memory copy of a tombstoned session; the durable copy is the deletion layer's job. */
  function forgetSession(sessionID: string): void {
    records.delete(sessionID)
    index.delete(sessionID)
    pendingRecords = pendingRecords.filter((record) => record.sessionID !== sessionID)
  }

  function coverageFor(directory: string | undefined): CoverageRecord | undefined {
    const key = directoryKeyOf(directory)
    const cached = coverage.get(key)
    if (cached !== undefined) return cached
    const stored = deps.repository.readCoverage(directory)
    if (stored !== undefined) coverage.set(key, stored)
    return stored
  }

  function statusFor(directory: string | undefined): DirectoryStatus {
    const key = directoryKeyOf(directory)
    let status = statuses.get(key)
    if (status === undefined) {
      status = { refreshing: false, failed: false }
      statuses.set(key, status)
    }
    return status
  }

  function viewsOf(directory: string | undefined): ViewEntry[] {
    const matching: ViewEntry[] = []
    for (const entry of views.values()) {
      if (entry.request.directory === directory) matching.push(entry)
    }
    return matching
  }

  function requestedDirectories(): (string | undefined)[] {
    const directories: (string | undefined)[] = []
    for (const entry of views.values()) {
      if (!directories.some((directory) => directory === entry.request.directory)) {
        directories.push(entry.request.directory)
      }
    }
    return directories
  }

  /** Sessions in coverage for the scope, i.e. how much of the cache the view is built from. */
  function countIndex(directory: string | undefined): number {
    let count = 0
    for (const entry of index.values()) if (matchesScope(entry.directory, directory)) count += 1
    return count
  }

  function liveView(request: ViewRequest): { samples: Sample[]; unavailable: UnavailableSample[] } {
    const fromMs = rangeStartMs(request.range, now())
    const samples: Sample[] = []
    const unavailable: UnavailableSample[] = []
    for (const entry of index.values()) {
      if (!matchesScope(entry.directory, request.directory)) continue
      if (fromMs !== undefined && entry.updatedAt < fromMs) continue
      const record = records.get(entry.sessionID)
      if (record === undefined) continue
      const inRange = inRangeSamples(record, fromMs)
      samples.push(...inRange.samples)
      unavailable.push(...inRange.unavailable)
    }
    return { samples, unavailable }
  }

  function buildState(
    request: ViewRequest,
    kind: ViewState["kind"],
    lastCheckedAt: number | undefined,
    refreshing: boolean,
    refreshFailed: boolean,
  ): ViewState {
    const data = liveView(request)
    const hasData = data.samples.length > 0 || data.unavailable.length > 0
    return {
      // Progressive publication never reports "partial" before there is anything to show.
      kind: kind === "partial" && !hasData ? "loading" : kind,
      samples: data.samples,
      unavailable: data.unavailable,
      variants: collectVariants(data.samples, data.unavailable),
      scanned: countIndex(request.directory),
      lastCheckedAt,
      refreshing,
      refreshFailed,
      persistence,
    }
  }

  function publishViews(directory: string | undefined, mode: "progress" | "ready" | "failure"): void {
    const status = statusFor(directory)
    for (const entry of viewsOf(directory)) {
      const kind: ViewState["kind"] = mode === "ready" ? "ready" : mode === "failure" ? "error" : "partial"
      entry.publish(
        buildState(
          entry.request,
          kind,
          entry.lastCheckedAt,
          mode !== "ready",
          mode === "failure" || status.failed,
        ),
      )
    }
    if (mode === "failure") publishWidgetFailure()
    else publishWidget(mode === "ready")
  }

  function publishWidget(persist: boolean): void {
    const nowMs = now()
    const rows = widgetRows(allSamples(), nowMs)
    widgetPublished = true
    setWidgetState({ status: "ready", rows, stale: false })
    if (persist) void persistWidget(rows, nowMs)
  }

  function publishWidgetFailure(): void {
    const current = widgetState()
    setWidgetState(
      widgetPublished
        ? { status: "ready", rows: current.rows, stale: true }
        : { status: "error", rows: [], stale: false },
    )
  }

  async function persistWidget(rows: WidgetRow[], nowMs: number): Promise<void> {
    try {
      await deps.repository.writeWidgetSnapshot(rows, nowMs)
    } catch {
      persistence = "unavailable"
    }
  }

  function allSamples(): Sample[] {
    const samples: Sample[] = []
    for (const record of records.values()) samples.push(...record.samples)
    return samples
  }

  async function flushRecords(): Promise<void> {
    if (pendingRecords.length === 0) return
    const batch = pendingRecords
    pendingRecords = []
    try {
      await deps.repository.putRecords(batch, now())
      // Records are the payload that matters: their write is what earns a clean persistence verdict.
      persistence = "ok"
    } catch {
      pendingRecords = [...batch, ...pendingRecords]
      persistence = "unavailable"
    }
  }

  async function readMeta(sessionID: string): Promise<SessionMeta | undefined> {
    const get = client.session.get
    if (get === undefined) return undefined
    try {
      return await get.call(client.session, { sessionID })
    } catch {
      // A session that vanished (or a transient read error) keeps the listing metadata for this pass.
      return undefined
    }
  }

  /**
   * Fresh metadata, scan, re-read. The record is stored even when the metadata moved mid-scan, but
   * the caller then rescans once so coverage is only claimed for data that matched a stable session.
   */
  async function scanSession(meta: SessionMeta): Promise<ScanOutcome> {
    const fresh = (await readMeta(meta.id)) ?? meta
    const scan = await scanMessages(client, fresh)
    const after = (await readMeta(meta.id)) ?? fresh
    if (tombstones.has(fresh.id)) {
      forgetSession(fresh.id)
      return { meta: after, requeue: false }
    }
    const record = recordFrom(fresh, scan, now())
    records.set(record.sessionID, record)
    index.set(record.sessionID, {
      sessionID: record.sessionID,
      directory: record.directory,
      updatedAt: record.updatedAt,
    })
    pendingRecords.push(record)
    return { meta: after, requeue: signatureFor(after) !== signatureFor(fresh) }
  }

  function cancelPublish(): void {
    if (publishCancel === undefined) return
    publishCancel()
    publishCancel = undefined
  }

  function schedulePublish(directory: string | undefined): void {
    if (publishCancel !== undefined) return
    const elapsed = now() - (lastPublishedAt ?? now())
    publishCancel = deps.delay(() => {
      publishCancel = undefined
      void publishDeferred(directory)
    }, Math.max(0, PUBLISH_INTERVAL_MS - elapsed))
  }

  async function publishDeferred(directory: string | undefined): Promise<void> {
    try {
      await flushRecords()
      publishViews(directory, "progress")
      lastPublishedAt = now()
    } catch {
      // A publication must never escape the service boundary.
    }
  }

  async function publishProgress(directory: string | undefined): Promise<void> {
    if (lastPublishedAt !== undefined && now() - lastPublishedAt < PUBLISH_INTERVAL_MS) {
      schedulePublish(directory)
      return
    }
    await flushRecords()
    publishViews(directory, "progress")
    lastPublishedAt = now()
  }

  /** Bounded worker pool over the listing order; stops taking new work once no consumer holds the service. */
  async function drain(
    directory: string | undefined,
    items: SessionMeta[],
    onRequeue: (meta: SessionMeta) => void,
  ): Promise<boolean> {
    let cursor = 0
    let abandoned = false
    const worker = async (): Promise<void> => {
      for (;;) {
        if (holds === 0) {
          abandoned = true
          return
        }
        const position = cursor
        cursor += 1
        if (position >= items.length) return
        const outcome = await scanSession(items[position])
        if (outcome.requeue) onRequeue(outcome.meta)
        await publishProgress(directory)
      }
    }
    const workers = Math.min(concurrency, Math.max(1, items.length))
    await Promise.all(Array.from({ length: workers }, () => worker()))
    return abandoned
  }

  async function commitCoverage(
    directory: string | undefined,
    startedAt: number,
    inventory: boolean,
    previous: CoverageRecord | undefined,
  ): Promise<void> {
    const next: CoverageRecord = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      directoryFilter: directory,
      fullInventoryCompletedAt: inventory ? startedAt : previous?.fullInventoryCompletedAt,
      recentCatchUpAt: startedAt,
    }
    try {
      await deps.repository.writeCoverage(next)
      coverage.set(directoryKeyOf(directory), next)
    } catch {
      persistence = "unavailable"
    }
  }

  async function publishReady(directory: string | undefined): Promise<void> {
    cancelPublish()
    await flushRecords()
    const checkedAt = now()
    for (const entry of viewsOf(directory)) {
      const data = liveView(entry.request)
      entry.lastCheckedAt = checkedAt
      const snapshot: ViewSnapshot = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        metricVersion: METRIC_VERSION,
        directoryFilter: entry.request.directory,
        range: entry.request.range,
        rows: comparisonRows(data.samples, data.unavailable),
        lastCheckedAt: checkedAt,
        savedAtMs: checkedAt,
      }
      try {
        await deps.repository.writeViewSnapshot(snapshot)
      } catch {
        persistence = "unavailable"
      }
    }
    publishViews(directory, "ready")
  }

  async function runPass(directory: string | undefined): Promise<void> {
    const status = statusFor(directory)
    status.refreshing = true
    const startedAt = now()
    const previous = coverageFor(directory)
    const inventory =
      previous?.fullInventoryCompletedAt === undefined ||
      startedAt - previous.fullInventoryCompletedAt > INVENTORY_MIN_INTERVAL_MS
    try {
      const listing = await listSessions(
        client,
        inventory || previous?.recentCatchUpAt === undefined
          ? { directory }
          : { directory, fromMs: previous.recentCatchUpAt },
      )
      rememberTombstones()
      const queue: SessionMeta[] = []
      for (const meta of listing.sessions) {
        if (tombstones.has(meta.id)) {
          forgetSession(meta.id)
          continue
        }
        const existing = records.get(meta.id)
        if (existing !== undefined && existing.signature === signatureFor(meta)) continue
        queue.push(meta)
      }

      const requeue: SessionMeta[] = []
      const abandoned = await drain(directory, queue, (meta) => {
        if (!requeue.some((item) => item.id === meta.id)) requeue.push(meta)
      })
      if (abandoned) {
        cancelPublish()
        return
      }
      const abandonedAgain = await drain(directory, requeue, () => {})
      if (abandonedAgain) {
        cancelPublish()
        return
      }

      await flushRecords()
      await commitCoverage(directory, startedAt, inventory, previous)
      status.refreshing = false
      status.failed = false
      await publishReady(directory)
    } catch {
      status.refreshing = true
      status.failed = true
      cancelPublish()
      publishViews(directory, "failure")
    }
  }

  function ensurePass(directory: string | undefined): void {
    const key = directoryKeyOf(directory)
    const slot = passes.get(key)
    if (slot?.inFlight === true) {
      slot.queued = true
      return
    }
    const next: PassSlot = { inFlight: true, queued: false }
    passes.set(key, next)
    void runPass(directory).finally(() => {
      next.inFlight = false
      if (next.queued) {
        next.queued = false
        ensurePass(directory)
      }
    })
  }

  function hasViews(directory: string | undefined): boolean {
    return viewsOf(directory).length > 0
  }

  /** Acquisition is background work: it starts only while a consumer holds the service. */
  function schedulePass(directory: string | undefined): void {
    if (holds === 0 || !hasViews(directory)) return
    void Promise.resolve().then(() => {
      ensurePass(directory)
    })
  }

  function startTimers(): void {
    if (timerCancel !== undefined) return
    timerCancel = deps.setTimer(() => {
      if (holds === 0) return
      for (const directory of requestedDirectories()) ensurePass(directory)
    }, RECENT_CATCHUP_MS)
    for (const directory of requestedDirectories()) schedulePass(directory)
  }

  function stopTimers(): void {
    cancelPublish()
    if (timerCancel !== undefined) {
      timerCancel()
      timerCancel = undefined
    }
  }

  function view(request: ViewRequest): Accessor<ViewState> {
    const key = viewKeyOf(request)
    const existing = views.get(key)
    if (existing !== undefined) return existing.accessor

    const snapshot = deps.repository.readViewSnapshot(request.directory, request.range)
    const lastCheckedAt = snapshot?.lastCheckedAt
    // The first read is synchronous: durable shards rebuild the cache, the snapshot says how fresh
    // it is, and a cached window is never reported as ready until the live pass replaces it.
    const [state, setState] = createSignal<ViewState>(
      buildState(request, snapshot === undefined ? "loading" : "cached", lastCheckedAt, true, false),
    )
    views.set(key, { request, accessor: state, publish: setState, lastCheckedAt })
    schedulePass(request.directory)
    return state
  }

  function hold(): () => void {
    holds += 1
    if (holds === 1) startTimers()
    let released = false
    return () => {
      if (released) return
      released = true
      holds -= 1
      if (holds === 0) stopTimers()
    }
  }

  function refreshNow(): void {
    for (const directory of requestedDirectories()) ensurePass(directory)
  }

  async function reset(): Promise<void> {
    cancelPublish()
    records.clear()
    index.clear()
    tombstones.clear()
    coverage.clear()
    pendingRecords = []
    widgetPublished = false
    setWidgetState({ status: "loading", rows: [], stale: false })
    for (const status of statuses.values()) {
      status.refreshing = true
      status.failed = false
    }
    for (const entry of views.values()) {
      entry.lastCheckedAt = undefined
      entry.publish(buildState(entry.request, "loading", undefined, true, false))
    }
    try {
      await deps.repository.clear()
    } catch {
      persistence = "unavailable"
    }
    for (const directory of requestedDirectories()) ensurePass(directory)
  }

  return { view, widget: () => widgetState, hold, refreshNow, reset }
}
