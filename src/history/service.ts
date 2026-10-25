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

/** Per-burst coalescing window for session events. */
export const DIRTY_DEBOUNCE_MS = 250
/** Hard bound on how long an event burst may defer work, measured from its first event. */
export const MAX_SCHEDULE_DELAY_MS = 1_000
/** Minimum gap between two progressive publications of the same directory filter. */
export const PUBLISH_INTERVAL_MS = 250
/** Background catch-up interval: the repeating timer tick while a consumer holds the service. */
export const RECENT_CATCHUP_MS = 60_000
/** A full inventory is repeated at least this often; catch-up listings cover the time in between. */
export const INVENTORY_MIN_INTERVAL_MS = 600_000
/** Revalidation interval for the background audit rotation. */
export const AUDIT_INTERVAL_MS = 60_000
/** Sessions re-scanned per audit tick, least recently scanned first. */
export const AUDIT_BATCH_SESSIONS = 20
/** Number of view snapshots the repository keeps, newest last. */
export const SNAPSHOT_LIMIT = 8

/**
 * Session events that invalidate a cached contribution: a completed or failed step, execution
 * termination, fork/create/move, revert or compaction changes, and usage changes. Streaming deltas
 * (`session.text.*`, `session.tool.*`, `session.reasoning.*`) are deliberately absent: they fire per
 * token and never change a completed measurement.
 */
const DIRTY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.step.ended",
  "session.step.failed",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.created",
  "session.forked",
  "session.moved",
  "session.revert.staged",
  "session.revert.committed",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.usage.recorded",
])

const DELETED_EVENT_TYPE = "session.deleted"

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
  /** Time of the last progressive publication for this filter; the throttle is per directory. */
  publishedAt: number | undefined
  publishCancel: (() => void) | undefined
}

/** Per-session scan bookkeeping: at most one scan in flight and one queued follow-up. */
interface SessionWork {
  /** Latest dirty revision requested by an event burst. */
  revision: number
  /** Highest revision a completed scan covered. */
  covered: number
  inFlight: boolean
  /** A scan of this session is scheduled on the next microtask. */
  pending: boolean
  followUp: boolean
}

interface ScanOutcome {
  /** Metadata as of the post-scan re-read: what the next listing pass will diff against. */
  meta: SessionMeta | undefined
  /** The metadata moved while the messages were read, so the session is scanned once more. */
  requeue: boolean
  /** A deletion or reset overtook the scan: nothing was stored. */
  discarded: boolean
}

/** One session scan requested outside a listing pass (a dirty event or the audit rotation). */
interface SessionScanResult {
  scanned: boolean
  directory: string | undefined
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
 * The installed client reports an unexpected HTTP status as `ClientError` with the status on `cause`;
 * anything else (transport errors, malformed responses) is inconclusive and never authorizes removal.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const fields = error as { status?: unknown; statusCode?: unknown; cause?: object; message?: unknown }
  if (fields.status === 404 || fields.statusCode === 404) return true
  if ((fields.cause as { status?: unknown } | undefined)?.status === 404) return true
  return typeof fields.message === "string" && /(?:^|\D)404(?:\D|$)/.test(fields.message)
}

/**
 * Shared, Solid-reactive history cache: one durable namespace and one acquisition pipeline for every
 * server and view. Signals are created without a component owner, so consumers only read accessors.
 *
 * `setTimer` drives the repeating catch-up and audit ticks, `delay` spaces the one-shot debounce and
 * progressive publications, and `subscribeEvents` is subscribed once per service for its lifetime
 * (the plugin owns the service and its teardown). Acquisition work starts only while a consumer holds
 * the service; the cache itself survives an unheld period.
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
  const work = new Map<string, SessionWork>()
  const dirty = new Set<string>()
  const scanTokens = new Map<string, number>()

  let holds = 0
  let timerCancel: (() => void) | undefined
  let auditCancel: (() => void) | undefined
  let burstCancel: (() => void) | undefined
  let burstStartedAt: number | undefined
  let flushInFlight: Promise<void> | undefined
  let resetGeneration = 0
  let pendingRecords: SessionRecord[] = []
  let persistence: "ok" | "unavailable" = "ok"
  let widgetPublished = false
  let hydrated = false

  const storedWidget = deps.repository.readWidgetSnapshot()
  const [widgetState, setWidgetState] = createSignal<WidgetSharedState>(
    storedWidget === undefined
      ? { status: "loading", rows: [], stale: false }
      : { status: "ready", rows: storedWidget.rows, stale: true },
  )
  if (storedWidget !== undefined) widgetPublished = true

  // Construction reads the widget snapshot and tombstones only: measurement shards hydrate lazily
  // on the first view or pass, so a widget-only startup never touches stored measurements.
  rememberTombstones()

  function rememberTombstones(): void {
    for (const sessionID of deps.repository.loadTombstones().sessionIDs) tombstones.add(sessionID)
  }

  /** Rebuilds the in-memory record/index maps from durable shards, at most once per process. */
  function hydrateShards(): void {
    if (hydrated) return
    hydrated = true
    for (const shard of deps.repository.loadAllShards().values()) {
      for (const entry of Object.values(shard.index)) {
        if (!tombstones.has(entry.sessionID)) index.set(entry.sessionID, entry)
      }
      for (const record of Object.values(shard.records)) {
        if (!tombstones.has(record.sessionID)) records.set(record.sessionID, record)
      }
    }
  }

  /** Drops an in-memory copy of a tombstoned session; the durable copy is the deletion layer's job. */
  function forgetSession(sessionID: string): void {
    records.delete(sessionID)
    index.delete(sessionID)
    dirty.delete(sessionID)
    pendingRecords = pendingRecords.filter((record) => record.sessionID !== sessionID)
  }

  function workOf(sessionID: string): SessionWork {
    const existing = work.get(sessionID)
    if (existing !== undefined) return existing
    const fresh: SessionWork = { revision: 0, covered: 0, inFlight: false, pending: false, followUp: false }
    work.set(sessionID, fresh)
    return fresh
  }

  function scanTokenOf(sessionID: string): number {
    return scanTokens.get(sessionID) ?? 0
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
      status = { refreshing: false, failed: false, publishedAt: undefined, publishCancel: undefined }
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
    // The sidebar holds the service before any page view exists. Its 24-hour all-project window is a
    // read-time filter over shared records, so a hold with no view registers all-projects coverage.
    if (directories.length === 0 && holds > 0) directories.push(undefined)
    return directories
  }

  /** Requested scopes that can see a session from `sessionDirectory`. */
  function affectedDirectories(sessionDirectory: string | undefined): (string | undefined)[] {
    return requestedDirectories().filter((directory) => matchesScope(sessionDirectory, directory))
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
    const generation = resetGeneration
    const batch = pendingRecords
    pendingRecords = []
    const flush = (async () => {
      try {
        await deps.repository.putRecords(batch, now())
        // Records are the payload that matters: their write is what earns a clean persistence verdict.
        persistence = "ok"
      } catch {
        // A reset owns the store from here: a pre-reset batch is never written back into it.
        if (generation === resetGeneration) pendingRecords = [...batch, ...pendingRecords]
        persistence = "unavailable"
      }
    })()
    flushInFlight = flush
    try {
      await flush
    } finally {
      if (flushInFlight === flush) flushInFlight = undefined
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
   * Fresh metadata, scan, re-read. A deletion event, a reset, or another scan of the same session
   * invalidates the result before it can be stored; a metadata change mid-scan stores the record but
   * asks for one follow-up so coverage is only claimed for data that matched a stable session.
   */
  async function scanSession(meta: SessionMeta): Promise<ScanOutcome | undefined> {
    if (tombstones.has(meta.id)) {
      forgetSession(meta.id)
      return { meta: undefined, requeue: false, discarded: true }
    }
    const state = workOf(meta.id)
    if (state.inFlight) {
      // A newer revision during a scan buys exactly one follow-up, never a revision loop.
      state.followUp = true
      return undefined
    }
    state.inFlight = true
    const revision = state.revision
    const generation = resetGeneration
    const token = scanTokenOf(meta.id)
    const current = (): boolean => generation === resetGeneration && scanTokenOf(meta.id) === token
    try {
      const fresh = (await readMeta(meta.id)) ?? meta
      if (!current()) return { meta: undefined, requeue: false, discarded: true }
      const scan = await scanMessages(client, fresh)
      if (!current()) return { meta: undefined, requeue: false, discarded: true }
      const after = (await readMeta(meta.id)) ?? fresh
      if (!current()) return { meta: undefined, requeue: false, discarded: true }
      if (tombstones.has(fresh.id)) {
        forgetSession(fresh.id)
        return { meta: after, requeue: false, discarded: true }
      }
      const record = recordFrom(fresh, scan, now())
      records.set(record.sessionID, record)
      index.set(record.sessionID, {
        sessionID: record.sessionID,
        directory: record.directory,
        updatedAt: record.updatedAt,
      })
      pendingRecords.push(record)
      return { meta: after, requeue: signatureFor(after) !== signatureFor(fresh), discarded: false }
    } finally {
      state.inFlight = false
      state.covered = Math.max(state.covered, revision)
      if (state.followUp || state.revision > state.covered) {
        state.followUp = false
        scheduleSessionScan(meta.id)
      }
    }
  }

  function cancelPublish(directory: string | undefined): void {
    const status = statuses.get(directoryKeyOf(directory))
    if (status?.publishCancel === undefined) return
    status.publishCancel()
    status.publishCancel = undefined
  }

  function cancelPublications(): void {
    for (const status of statuses.values()) {
      if (status.publishCancel === undefined) continue
      status.publishCancel()
      status.publishCancel = undefined
    }
  }

  function schedulePublish(directory: string | undefined): void {
    const status = statusFor(directory)
    if (status.publishCancel !== undefined) return
    const elapsed = now() - (status.publishedAt ?? now())
    status.publishCancel = deps.delay(() => {
      status.publishCancel = undefined
      void publishDeferred(directory)
    }, Math.max(0, PUBLISH_INTERVAL_MS - elapsed))
  }

  async function publishDeferred(directory: string | undefined): Promise<void> {
    try {
      await flushRecords()
      publishViews(directory, "progress")
      statusFor(directory).publishedAt = now()
    } catch {
      // A publication must never escape the service boundary.
    }
  }

  async function publishProgress(directory: string | undefined): Promise<void> {
    const status = statusFor(directory)
    if (status.publishedAt !== undefined && now() - status.publishedAt < PUBLISH_INTERVAL_MS) {
      schedulePublish(directory)
      return
    }
    await flushRecords()
    publishViews(directory, "progress")
    status.publishedAt = now()
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
        if (outcome?.requeue === true && outcome.meta !== undefined) onRequeue(outcome.meta)
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
    cancelPublish(directory)
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
    statusFor(directory).publishedAt = checkedAt
    publishViews(directory, "ready")
  }

  /**
   * Authoritative existence check for inventory verification. Only a definite not-found authorizes
   * removal; transport errors, authorization failures, and unexpected responses keep the cache.
   */
  async function probeSession(sessionID: string): Promise<"present" | "missing" | "unknown"> {
    const get = client.session.get
    if (get === undefined) return "unknown"
    try {
      await get.call(client.session, { sessionID })
      return "present"
    } catch (error) {
      return isNotFound(error) ? "missing" : "unknown"
    }
  }

  /**
   * A full listing only establishes deletion when each previously cached-but-unseen session was
   * checked individually. Tombstones are released only after a fully verified inventory in which no
   * new deletion was learned, so a session a listing still reports is never re-added while tombstoned.
   */
  async function verifyInventory(listed: Set<string>, known: readonly string[]): Promise<void> {
    if (client.session.get === undefined) return
    const tombstoned = [...tombstones]
    let removed = false
    let verified = true
    for (const sessionID of known) {
      if (listed.has(sessionID) || tombstones.has(sessionID)) continue
      const state = await probeSession(sessionID)
      if (state === "missing") {
        await deleteSession(sessionID)
        removed = true
      } else if (state === "unknown") {
        verified = false
      }
    }
    if (removed || !verified) return
    for (const sessionID of tombstoned) {
      if ((await probeSession(sessionID)) !== "missing") {
        verified = false
        break
      }
    }
    if (!verified || tombstoned.length === 0) return
    try {
      await deps.repository.clearTombstones(now())
      tombstones.clear()
    } catch {
      persistence = "unavailable"
    }
  }

  /** Removes a session immediately: token first so an in-flight scan cannot store it again. */
  async function deleteSession(sessionID: string): Promise<void> {
    scanTokens.set(sessionID, scanTokenOf(sessionID) + 1)
    tombstones.add(sessionID)
    const directory = records.get(sessionID)?.directory ?? index.get(sessionID)?.directory
    forgetSession(sessionID)
    try {
      await deps.repository.removeSessions([sessionID], now())
    } catch {
      persistence = "unavailable"
    }
    await publishSessionWork([directory], "settled")
  }

  /** Any scheduled or in-flight session work means a view is not settled yet. */
  function unsettled(): boolean {
    for (const state of work.values()) {
      if (state.inFlight || state.pending || state.followUp || state.revision > state.covered) return true
    }
    return false
  }

  async function publishSessionWork(
    sessionDirectories: readonly (string | undefined)[],
    mode: "progress" | "settled",
  ): Promise<void> {
    const targets = new Set<string | undefined>()
    for (const sessionDirectory of sessionDirectories) {
      for (const directory of affectedDirectories(sessionDirectory)) targets.add(directory)
    }
    if (targets.size === 0) {
      await flushRecords()
      publishWidget(false)
      return
    }
    for (const directory of targets) {
      // Only a settled, pass-free refresh may claim readiness; event-driven work stays progressive.
      if (mode === "settled" && !statusFor(directory).refreshing && !unsettled()) {
        await publishReady(directory)
      } else {
        await publishProgress(directory)
      }
    }
  }

  function publishSessionFailure(sessionDirectory: string | undefined): void {
    const targets = affectedDirectories(sessionDirectory)
    if (targets.length === 0) {
      publishWidgetFailure()
      return
    }
    for (const directory of targets) {
      const status = statusFor(directory)
      status.refreshing = true
      status.failed = true
      publishViews(directory, "failure")
    }
  }

  /** Scans one session outside a listing pass; returns whether a scan ran and where it belongs. */
  async function scanOne(sessionID: string): Promise<SessionScanResult> {
    const meta = await readMeta(sessionID)
    if (meta === undefined) return { scanned: false, directory: undefined }
    const directory = meta.location?.directory
    if (tombstones.has(sessionID)) {
      forgetSession(sessionID)
      return { scanned: false, directory }
    }
    try {
      await scanSession(meta)
      return { scanned: true, directory }
    } catch {
      // A failed scan retains the previous record and reports the refresh failure.
      publishSessionFailure(directory)
      return { scanned: false, directory }
    }
  }

  /** Coalesced dirty work: a scan starts only through the debounce flush. */
  function scheduleSessionScan(sessionID: string): void {
    const state = workOf(sessionID)
    if (state.pending || state.inFlight) {
      if (state.revision > state.covered) state.followUp = true
      return
    }
    if (state.revision <= state.covered) return
    state.pending = true
    void Promise.resolve()
      .then(async () => {
        state.pending = false
        const result = await scanOne(sessionID)
        if (!result.scanned) return
        await publishSessionWork([result.directory], "progress")
      })
      .catch(() => {
        // Acquisition failures are reported per session; nothing reaches the timer.
      })
      .finally(() => {
        state.pending = false
      })
  }

  function scheduleDirtyFlush(): void {
    if (holds === 0 || dirty.size === 0) return
    const at = now()
    if (burstStartedAt === undefined) burstStartedAt = at
    burstCancel?.()
    burstCancel = undefined
    const remaining = Math.max(0, burstStartedAt + MAX_SCHEDULE_DELAY_MS - at)
    burstCancel = deps.delay(() => {
      burstCancel = undefined
      flushDirty()
    }, Math.min(DIRTY_DEBOUNCE_MS, remaining))
  }

  function flushDirty(): void {
    burstStartedAt = undefined
    if (holds === 0) return
    const sessions = [...dirty]
    dirty.clear()
    // Dirty sessions are enqueued before any further backfill work; one burst is one revision each.
    for (const sessionID of sessions) {
      const state = workOf(sessionID)
      state.revision += 1
      scheduleSessionScan(sessionID)
    }
  }

  function markDirty(sessionID: string): void {
    if (tombstones.has(sessionID)) return
    dirty.add(sessionID)
    scheduleDirtyFlush()
  }

  /**
   * Fair audit rotation: least recently scanned sessions first, then by id so a tick is deterministic.
   * Content-only changes share a metadata signature and are only found by these rescans.
   */
  function auditCandidates(): string[] {
    return [...index.values()]
      .filter((entry) => !tombstones.has(entry.sessionID))
      .map((entry) => ({ entry, scannedAt: records.get(entry.sessionID)?.scannedAtMs ?? 0 }))
      .sort(
        (left, right) =>
          left.scannedAt - right.scannedAt || left.entry.sessionID.localeCompare(right.entry.sessionID),
      )
      .slice(0, AUDIT_BATCH_SESSIONS)
      .map((candidate) => candidate.entry.sessionID)
  }

  async function runAudit(): Promise<void> {
    if (holds === 0) return
    const directories: (string | undefined)[] = []
    for (const sessionID of auditCandidates()) {
      if (holds === 0) break
      const result = await scanOne(sessionID)
      if (result.scanned) directories.push(result.directory)
    }
    if (directories.length > 0) await publishSessionWork(directories, "settled")
  }

  async function runPass(directory: string | undefined): Promise<void> {
    // Hydrate before diffing against cached records so unchanged sessions are skipped, not rescanned.
    hydrateShards()
    const status = statusFor(directory)
    status.refreshing = true
    const startedAt = now()
    const generation = resetGeneration
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
      if (generation !== resetGeneration) {
        // A reset superseded this pass: it owns the store and schedules the next pass itself.
        status.refreshing = true
        return
      }
      rememberTombstones()
      const known: string[] = []
      if (inventory) {
        for (const entry of index.values()) {
          if (tombstones.has(entry.sessionID)) continue
          if (!matchesScope(entry.directory, directory)) continue
          known.push(entry.sessionID)
        }
      }
      const listed = new Set<string>()
      const queue: SessionMeta[] = []
      for (const meta of listing.sessions) {
        listed.add(meta.id)
        if (tombstones.has(meta.id)) {
          forgetSession(meta.id)
          continue
        }
        const existing = records.get(meta.id)
        if (existing !== undefined && existing.signature === signatureFor(meta)) continue
        queue.push(meta)
      }
      if (inventory) await verifyInventory(listed, known)

      const requeue: SessionMeta[] = []
      const abandoned = await drain(directory, queue, (meta) => {
        if (!requeue.some((item) => item.id === meta.id)) requeue.push(meta)
      })
      if (abandoned) {
        cancelPublish(directory)
        return
      }
      const abandonedAgain = await drain(directory, requeue, () => {})
      if (abandonedAgain) {
        cancelPublish(directory)
        return
      }
      if (generation !== resetGeneration) {
        status.refreshing = true
        return
      }

      await flushRecords()
      if (generation !== resetGeneration) {
        status.refreshing = true
        return
      }
      await commitCoverage(directory, startedAt, inventory, previous)
      if (generation !== resetGeneration) {
        status.refreshing = true
        return
      }
      status.refreshing = false
      status.failed = false
      await publishReady(directory)
    } catch {
      if (generation !== resetGeneration) {
        status.refreshing = true
        return
      }
      status.refreshing = true
      status.failed = true
      cancelPublish(directory)
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

  /** Acquisition is background work: it starts only while a consumer holds a requesting surface. */
  function schedulePass(directory: string | undefined): void {
    if (holds === 0) return
    void Promise.resolve().then(() => {
      // Re-checked at run time so a view opened between scheduling and now supersedes the widget's
      // all-project request instead of running two passes for the same cache.
      if (holds === 0 || !requestedDirectories().some((requested) => requested === directory)) return
      ensurePass(directory)
    })
  }

  function startTimers(): void {
    if (timerCancel !== undefined) return
    timerCancel = deps.setTimer(() => {
      if (holds === 0) return
      for (const directory of requestedDirectories()) ensurePass(directory)
    }, RECENT_CATCHUP_MS)
    auditCancel = deps.setTimer(() => {
      void runAudit().catch(() => {
        // The audit reports per-session failures; it never throws at the timer.
      })
    }, AUDIT_INTERVAL_MS)
    // Marks that arrived while unattached are flushed now that a consumer is back.
    scheduleDirtyFlush()
    for (const directory of requestedDirectories()) schedulePass(directory)
  }

  function stopTimers(): void {
    cancelPublications()
    burstCancel?.()
    burstCancel = undefined
    burstStartedAt = undefined
    if (auditCancel !== undefined) {
      auditCancel()
      auditCancel = undefined
    }
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
    hydrateShards()
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
    // In-flight scans from before the reset are invalidated here and discarded on completion.
    resetGeneration += 1
    cancelPublications()
    burstCancel?.()
    burstCancel = undefined
    burstStartedAt = undefined
    dirty.clear()
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
      status.publishedAt = undefined
    }
    for (const entry of views.values()) {
      entry.lastCheckedAt = undefined
      entry.publish(buildState(entry.request, "loading", undefined, true, false))
    }
    try {
      // Settle a batch already handed to the repository, then wipe the store it wrote into.
      await flushInFlight
      await deps.repository.clear()
    } catch {
      persistence = "unavailable"
    }
    for (const directory of requestedDirectories()) ensurePass(directory)
  }

  function subscribeToEvents(): void {
    deps.subscribeEvents((event) => {
      const sessionID = event.data?.sessionID
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      if (event.type === DELETED_EVENT_TYPE) {
        void deleteSession(sessionID).catch(() => {
          // Deletion bookkeeping is best effort; the tombstone already blocks acquisition.
        })
        return
      }
      if (!DIRTY_EVENT_TYPES.has(event.type)) return
      markDirty(sessionID)
    })
  }

  subscribeToEvents()

  return { view, widget: () => widgetState, hold, refreshNow, reset }
}
