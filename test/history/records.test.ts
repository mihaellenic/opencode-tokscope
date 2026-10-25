import { describe, expect, test } from "bun:test"
import type { SessionMeta } from "../../src/harvest"
import {
  CACHE_SCHEMA_VERSION,
  METRIC_VERSION,
  emptyShard,
  parseCoverage,
  parseShard,
  parseTombstones,
  parseViewSnapshot,
  parseWidgetSnapshot,
  recordFrom,
  signatureFor,
  type SessionRecord,
  type Shard,
  type ViewSnapshot,
} from "../../src/history/records"
import type { Sample } from "../../src/metric"

const NOW = 1_700_000_000_000

const sample = (rate: number, completedAt: number, variant?: string): Sample => ({
  providerID: "acme",
  modelID: "m1",
  variant,
  rate,
  completedAt,
})

const record = (sessionID: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionID,
  directory: "/work/a",
  createdAt: NOW - 5_000,
  updatedAt: NOW - 1_000,
  fork: false,
  signature: `sig-${sessionID}`,
  scannedAtMs: NOW,
  complete: true,
  samples: [sample(40, NOW - 2_000)],
  unavailable: [],
  ...overrides,
})

const shard = (records: SessionRecord[]): Shard => ({
  schemaVersion: CACHE_SCHEMA_VERSION,
  metricVersion: METRIC_VERSION,
  records: Object.fromEntries(records.map((entry) => [entry.sessionID, entry])),
  index: Object.fromEntries(
    records.map((entry) => [
      entry.sessionID,
      { sessionID: entry.sessionID, directory: entry.directory, updatedAt: entry.updatedAt },
    ]),
  ),
})

/** Mirrors what a durable store reads back: JSON has no NaN, Infinity, or undefined values. */
const persisted = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

const meta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: "ses_alpha",
  time: { created: NOW - 10_000, updated: NOW - 1_000 },
  location: { directory: "/work/a" },
  cost: 0.25,
  tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 10, write: 5 } },
  ...overrides,
})

describe("signatureFor", () => {
  test("is stable for equal metadata", () => {
    expect(signatureFor(meta())).toBe(signatureFor(meta()))
    expect(signatureFor(meta())).toBe(signatureFor(meta()))
  })

  test("changes when update time, cost, tokens, or fork boundary change", () => {
    const base = signatureFor(meta())
    expect(signatureFor(meta({ time: { created: NOW - 10_000, updated: NOW - 500 } }))).not.toBe(base)
    expect(signatureFor(meta({ cost: 0.75 }))).not.toBe(base)
    expect(
      signatureFor(meta({ tokens: { input: 100, output: 201, reasoning: 50, cache: { read: 10, write: 5 } } })),
    ).not.toBe(base)
    expect(
      signatureFor(
        meta({ tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 11, write: 5 } } }),
      ),
    ).not.toBe(base)

    const forked = meta({
      fork: { sessionID: "ses_parent", boundary: { type: "before", messageID: "msg_1" } },
    })
    expect(
      signatureFor(
        meta({ fork: { sessionID: "ses_parent", boundary: { type: "through", messageID: "msg_1" } } }),
      ),
    ).not.toBe(signatureFor(forked))
    expect(
      signatureFor(
        meta({ fork: { sessionID: "ses_parent", boundary: { type: "before", messageID: "msg_2" } } }),
      ),
    ).not.toBe(signatureFor(forked))
  })
})

describe("emptyShard", () => {
  test("is versioned and returns independent empty containers", () => {
    const first = emptyShard()
    expect(first.schemaVersion).toBe(CACHE_SCHEMA_VERSION)
    expect(first.metricVersion).toBe(METRIC_VERSION)
    expect(first.records).toEqual({})
    expect(first.index).toEqual({})

    first.records["ses_alpha"] = record("ses_alpha")
    expect(emptyShard().records).toEqual({})
  })
})

describe("recordFrom", () => {
  test("derives a complete record from metadata and a scan", () => {
    const session = meta({ fork: { sessionID: "ses_parent", boundary: { type: "before", messageID: "msg_1" } } })
    const scan = {
      samples: [sample(40, NOW - 2_000), sample(80, NOW - 1_500, "high")],
      unavailable: [{ providerID: "acme", modelID: "m2", variant: undefined, completedAt: NOW - 1_800 }],
    }

    const result = recordFrom(session, scan, NOW)

    expect(result).toEqual({
      sessionID: "ses_alpha",
      directory: "/work/a",
      createdAt: NOW - 10_000,
      updatedAt: NOW - 1_000,
      fork: true,
      signature: signatureFor(session),
      scannedAtMs: NOW,
      complete: true,
      samples: scan.samples,
      unavailable: scan.unavailable,
    })
    expect(Object.keys(result).sort()).toEqual([
      "complete",
      "createdAt",
      "directory",
      "fork",
      "samples",
      "scannedAtMs",
      "sessionID",
      "signature",
      "unavailable",
      "updatedAt",
    ])
  })

  test("marks sessions without a location or fork", () => {
    const result = recordFrom(
      meta({ location: undefined, fork: undefined }),
      { samples: [], unavailable: [] },
      NOW,
    )
    expect(result.directory).toBeUndefined()
    expect(result.fork).toBe(false)
    expect(result.complete).toBe(true)
  })
})

describe("parseShard", () => {
  test("rejects unknown schema and metric versions", () => {
    const valid = shard([record("ses_a")])
    expect(parseShard(valid)).toBeDefined()
    expect(parseShard({ ...valid, schemaVersion: CACHE_SCHEMA_VERSION + 1 })).toBeUndefined()
    expect(parseShard({ ...valid, metricVersion: METRIC_VERSION + 1 })).toBeUndefined()
    expect(parseShard({ ...valid, schemaVersion: undefined })).toBeUndefined()
    expect(parseShard({ ...valid, metricVersion: undefined })).toBeUndefined()
  })

  test("drops one invalid record but keeps valid neighbours from the same shard", () => {
    const corrupted = shard([
      record("ses_a"),
      record("ses_b", { samples: [sample(Number.NaN, NOW - 2_000)] }),
      record("ses_c", {
        unavailable: [{ providerID: "acme", modelID: "m2", variant: undefined, completedAt: NOW }],
      }),
    ])

    const parsed = parseShard(persisted(corrupted))

    expect(parsed?.records.ses_a).toBeDefined()
    expect(parsed?.records.ses_a.samples[0].rate).toBe(40)
    expect(parsed?.records.ses_b).toBeUndefined()
    expect(parsed?.records.ses_c).toBeDefined()
    expect(Object.keys(parsed?.records ?? {}).sort()).toEqual(["ses_a", "ses_c"])
    expect(Object.keys(parsed?.index ?? {}).sort()).toEqual(["ses_a", "ses_b", "ses_c"])

    // A hand-edited or in-memory NaN rate is invalid even before the JSON round trip.
    expect(parseShard(corrupted)?.records.ses_b).toBeUndefined()
    expect(parseShard(corrupted)?.records.ses_a.samples[0].rate).toBe(40)
  })

  test("rejects records with non-finite timestamps, non-positive rates, or missing arrays", () => {
    const invalid = [
      record("ses_a", { createdAt: Number.POSITIVE_INFINITY }),
      record("ses_b", { scannedAtMs: Number.NaN }),
      record("ses_c", {
        samples: [{ providerID: "acme", modelID: "m1", variant: undefined, rate: -1, completedAt: NOW }],
      }),
      record("ses_d", { unavailable: "none" as unknown as SessionRecord["unavailable"] }),
      record("ses_e", { sessionID: "" }),
      record("ses_f", { sessionID: "ses/../escape" }),
    ]

    const parsed = parseShard(persisted(shard(invalid)))

    expect(parsed?.records).toEqual({})
    expect(parsed?.schemaVersion).toBe(CACHE_SCHEMA_VERSION)
    // Index entries survive so the service still knows the session needs a fresh scan.
    expect(Object.keys(parsed?.index ?? {}).sort()).toEqual(["ses_a", "ses_b", "ses_c", "ses_d"])
  })

  test("drops records whose key disagrees with the record's session id", () => {
    const valid = shard([record("ses_a")])
    const misKeyed: Record<string, unknown> = {
      ...valid,
      records: { ses_other: valid.records.ses_a },
      index: { ses_other: valid.index.ses_a },
    }
    expect(parseShard(misKeyed)).toEqual({
      schemaVersion: CACHE_SCHEMA_VERSION,
      metricVersion: METRIC_VERSION,
      records: {},
      index: {},
    })
  })

  test("round-trips a persisted valid shard without mutating its input", () => {
    const valid = deepFreeze(shard([record("ses_a"), record("ses_b", { directory: undefined, fork: true })]))
    const snapshot = persisted(valid)

    const parsed = parseShard(persisted(valid))

    expect(parsed).toEqual(snapshot)
    expect(parseShard(valid)).toEqual(snapshot)
  })
})

describe("parseCoverage", () => {
  test("accepts watermarks and rejects unknown schema or malformed fields", () => {
    const valid = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      directoryFilter: "/work/a",
      fullInventoryCompletedAt: NOW,
      recentCatchUpAt: NOW - 1_000,
    }
    expect(parseCoverage(persisted(valid))).toEqual(valid)

    const allProjects = { ...valid, directoryFilter: undefined, recentCatchUpAt: undefined }
    const parsedAll = parseCoverage(persisted(allProjects))
    expect(parsedAll?.directoryFilter).toBeUndefined()
    expect(parsedAll?.recentCatchUpAt).toBeUndefined()
    expect(parsedAll?.fullInventoryCompletedAt).toBe(NOW)

    expect(parseCoverage({ ...valid, schemaVersion: CACHE_SCHEMA_VERSION + 1 })).toBeUndefined()
    expect(parseCoverage({ ...valid, fullInventoryCompletedAt: Number.POSITIVE_INFINITY })).toBeUndefined()
    expect(parseCoverage({ ...valid, directoryFilter: 7 })).toBeUndefined()
  })
})

describe("parseViewSnapshot", () => {
  const row = { key: "acme/m1", providerID: "acme", modelID: "m1", median: 42, calls: 3, unavailable: false }
  const valid: ViewSnapshot = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    metricVersion: METRIC_VERSION,
    directoryFilter: "/work/a",
    range: "last30",
    rows: [row, { ...row, key: "acme/m2", modelID: "m2", median: null, calls: 0, unavailable: true }],
    lastCheckedAt: NOW - 1_000,
    savedAtMs: NOW,
  }

  test("accepts a valid snapshot, including a nullable median", () => {
    expect(parseViewSnapshot(persisted(valid))).toEqual(valid)
    const withoutFilters = parseViewSnapshot(
      persisted({ ...valid, directoryFilter: undefined, lastCheckedAt: undefined }),
    )
    expect(withoutFilters?.directoryFilter).toBeUndefined()
    expect(withoutFilters?.lastCheckedAt).toBeUndefined()
  })

  test("rejects non-finite savedAtMs, non-array rows, unknown ranges, and stale versions", () => {
    expect(parseViewSnapshot({ ...valid, savedAtMs: Number.NaN })).toBeUndefined()
    expect(parseViewSnapshot({ ...valid, savedAtMs: Number.POSITIVE_INFINITY })).toBeUndefined()
    expect(parseViewSnapshot({ ...valid, savedAtMs: "now" })).toBeUndefined()
    expect(parseViewSnapshot({ ...valid, rows: "rows" })).toBeUndefined()
    expect(parseViewSnapshot({ ...valid, rows: undefined })).toBeUndefined()
    expect(parseViewSnapshot({ ...valid, rows: [{ ...row, median: Number.NaN }] })).toBeUndefined()
    expect(parseViewSnapshot({ ...valid, range: "last365" })).toBeUndefined()
    expect(parseViewSnapshot({ ...valid, metricVersion: METRIC_VERSION + 1 })).toBeUndefined()
    expect(parseViewSnapshot({ ...valid, schemaVersion: CACHE_SCHEMA_VERSION + 1 })).toBeUndefined()
  })
})

describe("parseWidgetSnapshot", () => {
  const row = { key: "acme/m1", providerID: "acme", modelID: "m1", median: 42, calls: 3 }
  const valid = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    metricVersion: METRIC_VERSION,
    rows: [row],
    savedAtMs: NOW,
  }

  test("accepts a valid snapshot and rejects malformed rows or versions", () => {
    expect(parseWidgetSnapshot(persisted(valid))).toEqual(valid)
    expect(parseWidgetSnapshot({ ...valid, rows: [{ ...row, median: Number.POSITIVE_INFINITY }] })).toBeUndefined()
    expect(parseWidgetSnapshot({ ...valid, rows: [{ ...row, calls: "3" }] })).toBeUndefined()
    expect(parseWidgetSnapshot({ ...valid, savedAtMs: Number.NaN })).toBeUndefined()
    expect(parseWidgetSnapshot({ ...valid, metricVersion: METRIC_VERSION + 1 })).toBeUndefined()
  })
})

describe("parseTombstones", () => {
  test("keeps valid session ids and drops malformed entries", () => {
    expect(parseTombstones(persisted({ sessionIDs: ["ses_a", "ses_b"] }))).toEqual({
      sessionIDs: ["ses_a", "ses_b"],
    })
    expect(parseTombstones({ sessionIDs: ["ses_a", "", 7, null, "ses/../b"] })).toEqual({ sessionIDs: ["ses_a"] })
    expect(parseTombstones({ sessionIDs: [] })).toEqual({ sessionIDs: [] })
    expect(parseTombstones({ sessionIDs: "ses_a" })).toBeUndefined()
  })
})

describe("parsers reject non-record payloads", () => {
  test("arrays, strings, numbers, and null are not accepted", () => {
    for (const payload of [null, [], ["ses_a"], "shard", 7, true]) {
      expect(parseShard(payload)).toBeUndefined()
      expect(parseCoverage(payload)).toBeUndefined()
      expect(parseViewSnapshot(payload)).toBeUndefined()
      expect(parseWidgetSnapshot(payload)).toBeUndefined()
      expect(parseTombstones(payload)).toBeUndefined()
    }
  })
})
