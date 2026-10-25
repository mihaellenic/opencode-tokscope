import type { RangeFilter } from "../filters"
import type { WidgetRow } from "../sidebar/rank"
import {
  CACHE_SCHEMA_VERSION,
  METRIC_VERSION,
  emptyShard,
  parseCoverage,
  parseShard,
  parseTombstones,
  parseViewSnapshot,
  parseWidgetSnapshot,
  type CoverageRecord,
  type SessionRecord,
  type Shard,
  type Tombstones,
  type ViewSnapshot,
  type WidgetSnapshot,
} from "./records"

/** Per-key durable JSON segments supplied by the host plugin storage (Task 7 provides the real one). */
export interface DurableStore {
  read(key: string): object | undefined
  write(key: string, mutate: (draft: Record<string, unknown>) => void): Promise<void>
}

export const SHARD_COUNT = 64

const TOMBSTONE_LIMIT = 1_000
const VIEW_SNAPSHOT_LIMIT = 8

const SHARD_PREFIX = "tks.shard."
const COVERAGE_PREFIX = "tks.coverage."
const COVERAGE_ALL_KEY = "tks.coverage.all"
const COVERAGE_INDEX_KEY = "tks.coverage-index"
const TOMBSTONES_KEY = "tks.tombstones"
const SNAPSHOTS_INDEX_KEY = "tks.snapshots"
const VIEW_SNAPSHOT_PREFIX = "tks.snapshot.view."
const WIDGET_SNAPSHOT_KEY = "tks.snapshot.widget24h"

/** FNV-1a, 32 bit: stable across runs, platforms, and processes; not a cryptographic hash. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0
  }
  return hash
}

function shardIndex(sessionID: string): number {
  return fnv1a(sessionID) % SHARD_COUNT
}

/** Map key of the shard owning `sessionID`; the durable segment is `tks.shard.<index>`. */
export function shardKey(sessionID: string): string {
  return shardName(shardIndex(sessionID))
}

function shardName(index: number): string {
  return `shard:${index}`
}

function shardStorageKey(index: number): string {
  return `${SHARD_PREFIX}${index}`
}

/** Directories are hashed so they never enter a durable key; a collision is detected on read. */
function coverageKey(directoryFilter: string | undefined): string {
  if (directoryFilter === undefined) return COVERAGE_ALL_KEY
  return `${COVERAGE_PREFIX}d${fnv1a(directoryFilter).toString(16).padStart(8, "0")}`
}

function isCoverageKey(key: string): boolean {
  return key === COVERAGE_ALL_KEY || key.startsWith(`${COVERAGE_PREFIX}d`)
}

/**
 * View snapshots live in a fixed set of slot keys. `tks.snapshots` lists the occupied keys,
 * newest last, so a write can find, refresh, or evict one without scanning the store.
 */
function viewSnapshotKey(slot: number): string {
  return `${VIEW_SNAPSHOT_PREFIX}${slot}`
}

function snapshotSlot(key: string): number | undefined {
  if (!key.startsWith(VIEW_SNAPSHOT_PREFIX)) return undefined
  const suffix = key.slice(VIEW_SNAPSHOT_PREFIX.length)
  if (!/^(?:0|[1-9][0-9]*)$/.test(suffix)) return undefined
  const slot = Number(suffix)
  return slot < VIEW_SNAPSHOT_LIMIT ? slot : undefined
}

function isSnapshotIndexKey(key: string): boolean {
  return snapshotSlot(key) !== undefined
}

function sameView(a: ViewSnapshot, b: ViewSnapshot): boolean {
  return a.directoryFilter === b.directoryFilter && a.range === b.range
}

interface LiveSnapshot {
  key: string
  slot: number
  snapshot: ViewSnapshot
}

/** Replaces the whole segment payload: a stale or unreadable shape must not survive a write. */
function replaceDraft(draft: Record<string, unknown>, value: object): void {
  for (const key of Object.keys(draft)) delete draft[key]
  Object.assign(draft, value)
}

/** Parses a `{ keys: string[] }` index payload, dropping entries that do not belong to it. */
function parseKeyIndex(
  payload: object | undefined,
  accept: (candidate: string) => boolean,
): string[] {
  const keys = payload === undefined ? undefined : (payload as { keys?: unknown }).keys
  if (!Array.isArray(keys)) return []
  const result: string[] = []
  for (const entry of keys) {
    if (typeof entry !== "string" || !accept(entry) || result.includes(entry)) continue
    result.push(entry)
  }
  return result
}

function readKeyIndex(
  store: DurableStore,
  key: string,
  accept: (candidate: string) => boolean,
): string[] {
  return parseKeyIndex(store.read(key), accept)
}

function mergeTombstones(existing: readonly string[], added: readonly string[]): string[] {
  const incoming = new Set(added)
  const merged = existing.filter((sessionID) => !incoming.has(sessionID))
  const seen = new Set<string>()
  for (const sessionID of added) {
    if (seen.has(sessionID)) continue
    seen.add(sessionID)
    merged.push(sessionID)
  }
  return merged.slice(-TOMBSTONE_LIMIT)
}

function cloneValue(value: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

/** Test double for the host store: JSON semantics, copy on read, one atomic write per key. */
export function createMemoryStore(): DurableStore & { dump(): Map<string, object> } {
  const segments = new Map<string, object>()
  return {
    read(key) {
      const value = segments.get(key)
      return value === undefined ? undefined : cloneValue(value)
    },
    async write(key, mutate) {
      const current = segments.get(key)
      const draft = current === undefined ? {} : cloneValue(current)
      mutate(draft)
      segments.set(key, cloneValue(draft))
    },
    dump() {
      const copy = new Map<string, object>()
      for (const [key, value] of segments) copy.set(key, cloneValue(value))
      return copy
    },
  }
}

export interface HistoryRepository {
  loadAllShards(): Map<string, Shard>
  /**
   * Merges complete per-session records into their shards, updating both the records and the
   * index entries. `nowMs` is part of the service call contract; persisted timestamps come from
   * each record's own `scannedAtMs`.
   */
  putRecords(records: SessionRecord[], nowMs: number): Promise<void>
  /**
   * Deletes the records and index entries, and tombstones the ids so an in-flight scan cannot
   * revive them. Callers consult `loadTombstones()` before writing a record back.
   */
  removeSessions(sessionIDs: string[], nowMs: number): Promise<void>
  loadTombstones(): Tombstones
  clearTombstones(nowMs: number): Promise<void>
  readCoverage(directoryFilter: string | undefined): CoverageRecord | undefined
  writeCoverage(record: CoverageRecord): Promise<void>
  readViewSnapshot(directoryFilter: string | undefined, range: RangeFilter): ViewSnapshot | undefined
  /** Keeps the newest eight views; an unreadable slot leaves the index on the next write. */
  writeViewSnapshot(snapshot: ViewSnapshot): Promise<void>
  readWidgetSnapshot(): WidgetSnapshot | undefined
  writeWidgetSnapshot(rows: WidgetRow[], nowMs: number): Promise<void>
  /** Empties every key the repository owns and nothing else. */
  clear(): Promise<void>
}

export function createRepository(store: DurableStore): HistoryRepository {
  const readTombstones = (): Tombstones =>
    parseTombstones(store.read(TOMBSTONES_KEY)) ?? { sessionIDs: [] }

  const readSnapshotIndex = (): string[] =>
    readKeyIndex(store, SNAPSHOTS_INDEX_KEY, isSnapshotIndexKey)

  /** Indexed slots whose payload still parses, in index order (oldest first). */
  const liveSnapshots = (keys: readonly string[]): LiveSnapshot[] => {
    const live: LiveSnapshot[] = []
    for (const key of keys) {
      const slot = snapshotSlot(key)
      if (slot === undefined) continue
      const parsed = parseViewSnapshot(store.read(key))
      // A slot that no longer parses leaves the index here: reads are synchronous, so this is the
      // only write path that can evict it.
      if (parsed !== undefined) live.push({ key, slot, snapshot: parsed })
    }
    return live
  }

  return {
    loadAllShards() {
      const shards = new Map<string, Shard>()
      for (let index = 0; index < SHARD_COUNT; index++) {
        const shard = parseShard(store.read(shardStorageKey(index)))
        if (shard !== undefined) shards.set(shardName(index), shard)
      }
      return shards
    },

    async putRecords(records: SessionRecord[], nowMs: number): Promise<void> {
      const grouped = new Map<number, SessionRecord[]>()
      for (const record of records) {
        const index = shardIndex(record.sessionID)
        const group = grouped.get(index)
        if (group === undefined) grouped.set(index, [record])
        else group.push(record)
      }
      // Per-key atomicity only: each affected shard is read, merged, and replaced in one write.
      for (const [index, group] of [...grouped].sort((a, b) => a[0] - b[0])) {
        await store.write(shardStorageKey(index), (draft) => {
          const shard = parseShard(draft) ?? emptyShard()
          for (const record of group) {
            shard.records[record.sessionID] = record
            shard.index[record.sessionID] = {
              sessionID: record.sessionID,
              directory: record.directory,
              updatedAt: record.updatedAt,
            }
          }
          replaceDraft(draft, shard)
        })
      }
    },

    async removeSessions(sessionIDs: string[], nowMs: number): Promise<void> {
      if (sessionIDs.length === 0) return

      // Tombstones land before the deletions: a failure in between leaves the deletion recorded
      // for the next pass instead of a removal an in-flight scan could resurrect.
      await store.write(TOMBSTONES_KEY, (draft) =>
        replaceDraft(draft, { sessionIDs: mergeTombstones(readTombstones().sessionIDs, sessionIDs) }),
      )

      const grouped = new Map<number, string[]>()
      for (const sessionID of sessionIDs) {
        const index = shardIndex(sessionID)
        const group = grouped.get(index)
        if (group === undefined) grouped.set(index, [sessionID])
        else group.push(sessionID)
      }
      for (const [index, group] of [...grouped].sort((a, b) => a[0] - b[0])) {
        const key = shardStorageKey(index)
        // Deletions never materialise an empty segment for a shard that was never written.
        if (store.read(key) === undefined) continue
        await store.write(key, (draft) => {
          const shard = parseShard(draft) ?? emptyShard()
          for (const sessionID of group) {
            delete shard.records[sessionID]
            delete shard.index[sessionID]
          }
          replaceDraft(draft, shard)
        })
      }
    },

    loadTombstones() {
      return readTombstones()
    },

    async clearTombstones(nowMs: number): Promise<void> {
      await store.write(TOMBSTONES_KEY, (draft) => replaceDraft(draft, { sessionIDs: [] }))
    },

    readCoverage(directoryFilter: string | undefined) {
      const record = parseCoverage(store.read(coverageKey(directoryFilter)))
      if (record === undefined) return undefined
      // The key only carries a 32-bit hash of the directory, so verify the payload before use.
      return record.directoryFilter === directoryFilter ? record : undefined
    },

    async writeCoverage(record: CoverageRecord): Promise<void> {
      const key = coverageKey(record.directoryFilter)
      // Index before payload: a failure in between leaves a key `clear()` can still find, never a
      // coverage record that `clear()` would miss. The list is merged from the draft, not from a
      // read taken before the write, so an index write that lands after another directory's can
      // never drop that directory's entry — an entry only `clear()` could otherwise reach.
      await store.write(COVERAGE_INDEX_KEY, (draft) => {
        const indexed = parseKeyIndex(draft, isCoverageKey)
        replaceDraft(draft, { keys: indexed.includes(key) ? indexed : [...indexed, key] })
      })
      await store.write(key, (draft) => replaceDraft(draft, record))
    },

    readViewSnapshot(directoryFilter: string | undefined, range: RangeFilter) {
      const index = readSnapshotIndex()
      for (let position = index.length - 1; position >= 0; position--) {
        const snapshot = parseViewSnapshot(store.read(index[position]))
        if (snapshot === undefined) continue
        if (snapshot.directoryFilter === directoryFilter && snapshot.range === range) return snapshot
      }
      return undefined
    },

    async writeViewSnapshot(snapshot: ViewSnapshot): Promise<void> {
      const live = liveSnapshots(readSnapshotIndex())

      const updated = live.filter((entry) => sameView(entry.snapshot, snapshot)).at(-1)
      const kept = live.filter((entry) => !sameView(entry.snapshot, snapshot))

      let slot: number
      if (updated !== undefined) {
        slot = updated.slot
      } else {
        const used = new Set(kept.map((entry) => entry.slot))
        const free = Array.from({ length: VIEW_SNAPSHOT_LIMIT }, (_, candidate) => candidate).find(
          (candidate) => !used.has(candidate),
        )
        if (free !== undefined) {
          slot = free
        } else {
          // All slots hold other views: FIFO-evict the oldest and reuse its slot.
          slot = kept[0].slot
          kept.shift()
        }
      }

      const key = viewSnapshotKey(slot)
      // Payload before index: a failure in between leaves an unreferenced snapshot the next write
      // overwrites, never an indexed slot without data.
      await store.write(key, (draft) => replaceDraft(draft, snapshot))
      // The key list is merged from the draft rather than written from the planning read, so an
      // entry another write appends in between is kept; the bound trims the oldest entries, which
      // is the same FIFO eviction picked above.
      await store.write(SNAPSHOTS_INDEX_KEY, (draft) => {
        const current = liveSnapshots(parseKeyIndex(draft, isSnapshotIndexKey))
          .filter((entry) => entry.key !== key && !sameView(entry.snapshot, snapshot))
          .map((entry) => entry.key)
        replaceDraft(draft, { keys: [...current, key].slice(-VIEW_SNAPSHOT_LIMIT) })
      })
    },

    readWidgetSnapshot() {
      return parseWidgetSnapshot(store.read(WIDGET_SNAPSHOT_KEY))
    },

    async writeWidgetSnapshot(rows: WidgetRow[], nowMs: number): Promise<void> {
      const snapshot: WidgetSnapshot = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        metricVersion: METRIC_VERSION,
        rows,
        savedAtMs: nowMs,
      }
      await store.write(WIDGET_SNAPSHOT_KEY, (draft) => replaceDraft(draft, snapshot))
    },

    async clear(): Promise<void> {
      const keys = [
        ...Array.from({ length: SHARD_COUNT }, (_, index) => shardStorageKey(index)),
        TOMBSTONES_KEY,
        COVERAGE_INDEX_KEY,
        ...readKeyIndex(store, COVERAGE_INDEX_KEY, isCoverageKey),
        SNAPSHOTS_INDEX_KEY,
        ...Array.from({ length: VIEW_SNAPSHOT_LIMIT }, (_, slot) => viewSnapshotKey(slot)),
        WIDGET_SNAPSHOT_KEY,
      ]
      for (const key of keys) {
        if (store.read(key) === undefined) continue
        await store.write(key, (draft) => replaceDraft(draft, {}))
      }
    },
  }
}
