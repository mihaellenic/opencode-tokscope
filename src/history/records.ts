import type { RangeFilter } from "../filters"
import type { SessionMeta } from "../harvest"
import { TOKEN_CATEGORIES, type RequestFact, type Sample, type UnavailableSample } from "../metric"
import type { WidgetRow } from "../sidebar/rank"
import type { ModelRow } from "../stats"

export const CACHE_SCHEMA_VERSION = 2
export const METRIC_VERSION = 2

export interface SessionRecord {
  sessionID: string
  directory: string | undefined
  createdAt: number
  updatedAt: number
  fork: boolean
  signature: string
  scannedAtMs: number
  complete: boolean
  samples: Sample[]
  unavailable: UnavailableSample[]
  requests: RequestFact[]
}

export interface SessionIndexEntry {
  sessionID: string
  directory: string | undefined
  updatedAt: number
}

export interface Shard {
  schemaVersion: number
  metricVersion: number
  records: Record<string, SessionRecord>
  index: Record<string, SessionIndexEntry>
}

export interface CoverageRecord {
  schemaVersion: number
  directoryFilter: string | undefined
  fullInventoryCompletedAt: number | undefined
  recentCatchUpAt: number | undefined
}

export interface ViewSnapshot {
  schemaVersion: number
  metricVersion: number
  directoryFilter: string | undefined
  range: RangeFilter
  rows: ModelRow[]
  lastCheckedAt: number | undefined
  savedAtMs: number
}

export interface WidgetSnapshot {
  schemaVersion: number
  metricVersion: number
  rows: WidgetRow[]
  savedAtMs: number
}

export interface Tombstones {
  sessionIDs: string[]
}

/** Records are keyed by session id, so ids must stay inside the durable key alphabet. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const RANGE_FILTERS: readonly RangeFilter[] = ["today", "last7", "last30", "last90", "all"]

type Fields = Record<string, unknown>

function fieldsOf(value: unknown): Fields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Fields
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function sessionIDFrom(value: unknown): string | undefined {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

/**
 * Optional fields accept absence but reject a malformed value, which invalidates the payload
 * instead of silently dropping a field such as a directory filter.
 */
function optionalField<T>(
  value: unknown,
  parse: (raw: unknown) => T | undefined,
): { ok: true; value: T | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined }
  const parsed = parse(value)
  return parsed === undefined ? { ok: false } : { ok: true, value: parsed }
}

function parseRows<T>(raw: unknown, parse: (value: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const rows: T[] = []
  for (const entry of raw) {
    const row = parse(entry)
    if (row === undefined) return undefined
    rows.push(row)
  }
  return rows
}

function parseSample(raw: unknown): Sample | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  const providerID = nonEmptyString(source.providerID)
  const modelID = nonEmptyString(source.modelID)
  const variant = optionalField(source.variant, stringValue)
  const completedAt = finiteNumber(source.completedAt)
  const rate = nonNegativeNumber(source.rate)
  if (
    providerID === undefined ||
    modelID === undefined ||
    !variant.ok ||
    completedAt === undefined ||
    rate === undefined
  ) {
    return undefined
  }
  return { providerID, modelID, variant: variant.value, completedAt, rate }
}

function parseUnavailableSample(raw: unknown): UnavailableSample | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  const providerID = nonEmptyString(source.providerID)
  const modelID = nonEmptyString(source.modelID)
  const variant = optionalField(source.variant, stringValue)
  const completedAt = finiteNumber(source.completedAt)
  if (providerID === undefined || modelID === undefined || !variant.ok || completedAt === undefined) {
    return undefined
  }
  return { providerID, modelID, variant: variant.value, completedAt }
}

function parseSessionRecord(raw: unknown): SessionRecord | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined

  const sessionID = sessionIDFrom(source.sessionID)
  const directory = optionalField(source.directory, stringValue)
  const createdAt = finiteNumber(source.createdAt)
  const updatedAt = finiteNumber(source.updatedAt)
  const scannedAtMs = finiteNumber(source.scannedAtMs)
  const signature = stringValue(source.signature)
  const fork = source.fork
  const complete = source.complete
  if (
    sessionID === undefined ||
    !directory.ok ||
    createdAt === undefined ||
    updatedAt === undefined ||
    scannedAtMs === undefined ||
    signature === undefined ||
    typeof fork !== "boolean" ||
    typeof complete !== "boolean"
  ) {
    return undefined
  }

  const samples = parseRows(source.samples, parseSample)
  const unavailable = parseRows(source.unavailable, parseUnavailableSample)
  const requests = parseRows(source.requests, parseRequestFact)
  if (samples === undefined || unavailable === undefined || requests === undefined) return undefined

  return {
    sessionID,
    directory: directory.value,
    createdAt,
    updatedAt,
    fork,
    signature,
    scannedAtMs,
    complete,
    samples,
    unavailable,
    requests,
  }
}

function parseIndexEntry(raw: unknown): SessionIndexEntry | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  const sessionID = sessionIDFrom(source.sessionID)
  const directory = optionalField(source.directory, stringValue)
  const updatedAt = finiteNumber(source.updatedAt)
  if (sessionID === undefined || !directory.ok || updatedAt === undefined) return undefined
  return { sessionID, directory: directory.value, updatedAt }
}

function parseRequestFact(raw: unknown): RequestFact | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  const providerID = nonEmptyString(source.providerID)
  const modelID = nonEmptyString(source.modelID)
  const variant = optionalField(source.variant, stringValue)
  const at = finiteNumber(source.at)
  const durationMs = optionalField(source.durationMs, nonNegativeNumber)
  if (providerID === undefined || modelID === undefined || !variant.ok || at === undefined || !durationMs.ok) {
    return undefined
  }
  const fact: RequestFact = { providerID, modelID, variant: variant.value, at }
  if (durationMs.value !== undefined) fact.durationMs = durationMs.value
  if (source.tokens !== undefined) {
    const tokens = fieldsOf(source.tokens)
    if (tokens === undefined) return undefined
    fact.tokens = {}
    for (const category of TOKEN_CATEGORIES) {
      const count = optionalField(tokens[category], nonNegativeNumber)
      if (!count.ok) return undefined
      if (count.value !== undefined) fact.tokens[category] = count.value
    }
  }
  return fact
}

function countNumber(raw: unknown): number | undefined {
  const value = nonNegativeNumber(raw)
  return value !== undefined && Number.isInteger(value) ? value : undefined
}

function nullableNumber(raw: unknown): number | null | undefined {
  return raw === null ? null : nonNegativeNumber(raw)
}

function parseModelRow(raw: unknown): ModelRow | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  const key = nonEmptyString(source.key)
  const providerID = nonEmptyString(source.providerID)
  const modelID = nonEmptyString(source.modelID)
  const requests = countNumber(source.requests)
  const throughputCalls = countNumber(source.throughputCalls)
  const total = nullableNumber(source.total)
  const responseMedian = nullableNumber(source.responseMedian)
  const responseP95 = nullableNumber(source.responseP95)
  const throughput = nullableNumber(source.throughput)
  const tokensSource = fieldsOf(source.tokens)
  const eligibleSource = fieldsOf(source.eligible)
  if (
    key === undefined || providerID === undefined || modelID === undefined ||
    requests === undefined || throughputCalls === undefined || total === undefined ||
    responseMedian === undefined || responseP95 === undefined || throughput === undefined ||
    tokensSource === undefined || eligibleSource === undefined
  ) {
    return undefined
  }
  const tokens = {} as ModelRow["tokens"]
  const eligible = {} as ModelRow["eligible"]
  for (const category of TOKEN_CATEGORIES) {
    const value = nullableNumber(tokensSource[category])
    if (value === undefined) return undefined
    tokens[category] = value
  }
  for (const category of [...TOKEN_CATEGORIES, "triple", "response"] as const) {
    const value = countNumber(eligibleSource[category])
    if (value === undefined) return undefined
    eligible[category] = value
  }
  return {
    key, providerID, modelID, requests, tokens, total,
    responseMedian, responseP95, throughput, throughputCalls, eligible,
  }
}

function parseWidgetRow(raw: unknown): WidgetRow | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  const key = nonEmptyString(source.key)
  const providerID = nonEmptyString(source.providerID)
  const modelID = nonEmptyString(source.modelID)
  const median = nonNegativeNumber(source.median)
  const calls = nonNegativeNumber(source.calls)
  if (
    key === undefined ||
    providerID === undefined ||
    modelID === undefined ||
    median === undefined ||
    calls === undefined
  ) {
    return undefined
  }
  return { key, providerID, modelID, median, calls }
}

export function signatureFor(meta: SessionMeta): string {
  return JSON.stringify([
    meta.id,
    meta.time.created,
    meta.time.updated,
    meta.location?.directory,
    meta.cost,
    meta.tokens,
    meta.fork?.sessionID,
    meta.fork?.boundary,
  ])
}

export function emptyShard(): Shard {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    metricVersion: METRIC_VERSION,
    records: {},
    index: {},
  }
}

export function parseShard(raw: unknown): Shard | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  if (source.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined
  if (source.metricVersion !== METRIC_VERSION) return undefined

  const recordsSource = fieldsOf(source.records)
  const indexSource = fieldsOf(source.index)
  if (recordsSource === undefined || indexSource === undefined) return undefined

  const records: Record<string, SessionRecord> = {}
  for (const [key, value] of Object.entries(recordsSource)) {
    const record = parseSessionRecord(value)
    if (record === undefined || record.sessionID !== key) continue
    records[key] = record
  }

  const index: Record<string, SessionIndexEntry> = {}
  for (const [key, value] of Object.entries(indexSource)) {
    const entry = parseIndexEntry(value)
    if (entry === undefined || entry.sessionID !== key) continue
    index[key] = entry
  }

  return { schemaVersion: CACHE_SCHEMA_VERSION, metricVersion: METRIC_VERSION, records, index }
}

export function parseCoverage(raw: unknown): CoverageRecord | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  if (source.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined

  const directoryFilter = optionalField(source.directoryFilter, stringValue)
  const fullInventoryCompletedAt = optionalField(source.fullInventoryCompletedAt, finiteNumber)
  const recentCatchUpAt = optionalField(source.recentCatchUpAt, finiteNumber)
  if (!directoryFilter.ok || !fullInventoryCompletedAt.ok || !recentCatchUpAt.ok) return undefined

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    directoryFilter: directoryFilter.value,
    fullInventoryCompletedAt: fullInventoryCompletedAt.value,
    recentCatchUpAt: recentCatchUpAt.value,
  }
}

export function parseViewSnapshot(raw: unknown): ViewSnapshot | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  if (source.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined
  if (source.metricVersion !== METRIC_VERSION) return undefined
  if (!RANGE_FILTERS.includes(source.range as RangeFilter)) return undefined

  const directoryFilter = optionalField(source.directoryFilter, stringValue)
  const lastCheckedAt = optionalField(source.lastCheckedAt, finiteNumber)
  const savedAtMs = finiteNumber(source.savedAtMs)
  const rows = parseRows(source.rows, parseModelRow)
  if (!directoryFilter.ok || !lastCheckedAt.ok || savedAtMs === undefined || rows === undefined) return undefined

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    metricVersion: METRIC_VERSION,
    directoryFilter: directoryFilter.value,
    range: source.range as RangeFilter,
    rows,
    lastCheckedAt: lastCheckedAt.value,
    savedAtMs,
  }
}

export function parseWidgetSnapshot(raw: unknown): WidgetSnapshot | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  if (source.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined
  if (source.metricVersion !== METRIC_VERSION) return undefined

  const rows = parseRows(source.rows, parseWidgetRow)
  const savedAtMs = finiteNumber(source.savedAtMs)
  if (rows === undefined || savedAtMs === undefined) return undefined

  return { schemaVersion: CACHE_SCHEMA_VERSION, metricVersion: METRIC_VERSION, rows, savedAtMs }
}

export function parseTombstones(raw: unknown): Tombstones | undefined {
  const source = fieldsOf(raw)
  if (source === undefined) return undefined
  if (!Array.isArray(source.sessionIDs)) return undefined

  const sessionIDs: string[] = []
  for (const entry of source.sessionIDs) {
    const sessionID = sessionIDFrom(entry)
    if (sessionID !== undefined) sessionIDs.push(sessionID)
  }
  return { sessionIDs }
}

export function recordFrom(
  meta: SessionMeta,
  scan: { samples: Sample[]; unavailable: UnavailableSample[]; requests: RequestFact[] },
  nowMs: number,
): SessionRecord {
  return {
    sessionID: meta.id,
    directory: meta.location?.directory,
    createdAt: meta.time.created,
    updatedAt: meta.time.updated,
    fork: meta.fork !== undefined,
    signature: signatureFor(meta),
    scannedAtMs: nowMs,
    complete: true,
    samples: scan.samples,
    unavailable: scan.unavailable,
    requests: scan.requests,
  }
}
