import { describe, expect, test } from "bun:test"
import type { WidgetRow } from "../../src/sidebar/rank"
import {
  CACHE_SCHEMA_VERSION,
  METRIC_VERSION,
  type CoverageRecord,
  type SessionRecord,
  type ViewSnapshot,
} from "../../src/history/records"
import {
  SHARD_COUNT,
  createMemoryStore,
  createRepository,
  fnv1a,
  shardKey,
  type DurableStore,
} from "../../src/history/durable"

const NOW = 1_700_000_000_000

const record = (sessionID: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionID,
  directory: "/work/a",
  createdAt: NOW - 5_000,
  updatedAt: NOW - 1_000,
  fork: false,
  signature: `sig-${sessionID}`,
  scannedAtMs: NOW,
  complete: true,
  samples: [{ providerID: "acme", modelID: "m1", variant: undefined, rate: 40, completedAt: NOW - 2_000 }],
  unavailable: [],
  ...overrides,
})

const coverage = (
  directoryFilter: string | undefined,
  overrides: Partial<CoverageRecord> = {},
): CoverageRecord => ({
  schemaVersion: CACHE_SCHEMA_VERSION,
  directoryFilter,
  fullInventoryCompletedAt: NOW,
  recentCatchUpAt: undefined,
  ...overrides,
})

const viewSnapshot = (overrides: Partial<ViewSnapshot> = {}): ViewSnapshot => ({
  schemaVersion: CACHE_SCHEMA_VERSION,
  metricVersion: METRIC_VERSION,
  directoryFilter: "/work/a",
  range: "last30",
  rows: [{ key: "acme/m1", providerID: "acme", modelID: "m1", median: 42, calls: 3, unavailable: false }],
  lastCheckedAt: NOW - 1_000,
  savedAtMs: NOW,
  ...overrides,
})

const widgetRows: WidgetRow[] = [{ key: "acme/m1", providerID: "acme", modelID: "m1", median: 42, calls: 3 }]

/** The durable key of the shard that owns a session, spelled out so the layout stays pinned. */
const shardSegmentKey = (sessionID: string): string => `tks.${shardKey(sessionID).replace(":", ".")}`

/** The durable coverage key for one directory, mirroring the hashed layout. */
const coverageStorageKey = (directory: string): string =>
  `tks.coverage.d${fnv1a(directory).toString(16).padStart(8, "0")}`

/** Ids that land in the same shard as `sessionID`, so merge and delete paths hit one segment. */
function sameShardID(sessionID: string, salt: string): string {
  for (let index = 0; ; index++) {
    const candidate = `ses_${salt}_${index}`
    if (shardKey(candidate) === shardKey(sessionID)) return candidate
  }
}

/** Seeds a raw durable payload, standing in for a hand-edited or stale segment. */
async function seed(store: DurableStore, key: string, value: object): Promise<void> {
  await store.write(key, (draft) => {
    for (const name of Object.keys(draft)) delete draft[name]
    Object.assign(draft, JSON.parse(JSON.stringify(value)) as object)
  })
}

/**
 * Applies each mutation a microtask after it is requested, like a host store that persists before
 * it commits: two calls can then both read a segment before either write to it lands.
 */
function createDeferredStore(): DurableStore & { dump(): Map<string, object> } {
  const base = createMemoryStore()
  return {
    read: (key) => base.read(key),
    async write(key, mutate) {
      await Promise.resolve()
      await base.write(key, mutate)
    },
    dump: () => base.dump(),
  }
}

const tksKeys = (store: Map<string, object>): string[] =>
  [...store.keys()].filter((key) => key.startsWith("tks.")).sort()

describe("shardKey", () => {
  test("is deterministic and stays inside the shard range", () => {
    expect(shardKey("ses_alpha")).toBe(shardKey("ses_alpha"))

    const shards = new Set<string>()
    for (let index = 0; index < 10_000; index++) {
      const sessionID = `ses_${index}`
      const key = shardKey(sessionID)
      expect(key).toBe(shardKey(sessionID))
      const shard = Number(key.slice("shard:".length))
      expect(Number.isInteger(shard)).toBe(true)
      expect(shard).toBeGreaterThanOrEqual(0)
      expect(shard).toBeLessThan(SHARD_COUNT)
      shards.add(key)
    }
    // Only a spread sanity check: the brief deliberately does not pin per-shard balance.
    expect(shards.size).toBeGreaterThan(1)
  })

  test("pins the hash and shard layout so persisted shards survive upgrades", () => {
    expect(fnv1a("")).toBe(0x811c9dc5)
    expect(fnv1a("a")).toBe(0xe40c292c)
    expect(shardKey("ses_alpha")).toBe("shard:25")
  })
})

describe("putRecords", () => {
  test("merges two scans of one session into a single replaced record and index entry", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)

    await repository.putRecords([record("ses_a")], NOW)
    await repository.putRecords(
      [
        record("ses_a", {
          directory: "/work/b",
          updatedAt: NOW + 500,
          scannedAtMs: NOW + 1_000,
          samples: [{ providerID: "acme", modelID: "m1", variant: "high", rate: 80, completedAt: NOW - 1_000 }],
        }),
      ],
      NOW + 1_000,
    )

    const shards = repository.loadAllShards()
    expect(shards.size).toBe(1)
    const shard = shards.get(shardKey("ses_a"))
    expect(Object.keys(shard?.records ?? {})).toEqual(["ses_a"])
    expect(shard?.records.ses_a.samples).toEqual([
      { providerID: "acme", modelID: "m1", variant: "high", rate: 80, completedAt: NOW - 1_000 },
    ])
    expect(shard?.records.ses_a.scannedAtMs).toBe(NOW + 1_000)
    expect(shard?.index.ses_a).toEqual({ sessionID: "ses_a", directory: "/work/b", updatedAt: NOW + 500 })
    expect(tksKeys(store.dump())).toEqual([shardSegmentKey("ses_a")])
  })

  test("writes one durable key per shard and no segment for an empty batch", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)

    await repository.putRecords([], NOW)
    expect(store.dump().size).toBe(0)

    const first = "ses_alpha"
    const second = sameShardID(first, "sibling")
    await repository.putRecords([record(first), record(second)], NOW)
    expect(repository.loadAllShards().size).toBe(1)
    expect(Object.keys(repository.loadAllShards().get(shardKey(first))?.records ?? {}).sort()).toEqual(
      [first, second].sort(),
    )
  })

  test("keeps valid siblings of a record that no longer parses and never writes it back", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)
    const valid = "ses_alpha"
    const corrupt = sameShardID(valid, "corrupt")
    const fresh = sameShardID(valid, "fresh")

    await repository.putRecords([record(valid), record(corrupt)], NOW)

    await store.write(shardSegmentKey(valid), (draft) => {
      const records = draft.records as Record<string, SessionRecord>
      records[corrupt].samples[0] = { ...records[corrupt].samples[0], rate: Number.NaN }
    })

    const parsed = repository.loadAllShards().get(shardKey(valid))
    expect(Object.keys(parsed?.records ?? {})).toEqual([valid])

    await repository.putRecords([record(fresh)], NOW)

    const merged = repository.loadAllShards().get(shardKey(valid))
    expect(Object.keys(merged?.records ?? {}).sort()).toEqual([valid, fresh].sort())
    // The unreadable record's index entry survives, so the session is rescanned instead of dropped.
    expect(Object.keys(merged?.index ?? {}).sort()).toEqual([valid, corrupt, fresh].sort())
  })

  test("replaces a shard whose schema version is unknown instead of merging into it", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)

    await repository.putRecords([record("ses_alpha")], NOW)
    await store.write(shardSegmentKey("ses_alpha"), (draft) => {
      draft.schemaVersion = CACHE_SCHEMA_VERSION + 1
    })
    expect(repository.loadAllShards().size).toBe(0)

    await repository.putRecords([record("ses_alpha")], NOW)

    const shard = repository.loadAllShards().get(shardKey("ses_alpha"))
    expect(shard?.schemaVersion).toBe(CACHE_SCHEMA_VERSION)
    expect(shard?.metricVersion).toBe(METRIC_VERSION)
    expect(Object.keys(shard?.records ?? {})).toEqual(["ses_alpha"])
  })
})

describe("removeSessions", () => {
  test("deletes the record and its index entry, keeps siblings, and records a tombstone", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)
    const removed = "ses_alpha"
    const sibling = sameShardID(removed, "sibling")

    await repository.putRecords([record(removed), record(sibling)], NOW)
    await repository.removeSessions([removed], NOW + 1)

    const shard = repository.loadAllShards().get(shardKey(removed))
    expect(shard?.records[sibling]).toBeDefined()
    expect(shard?.records[removed]).toBeUndefined()
    expect(shard?.index[sibling]).toBeDefined()
    expect(shard?.index[removed]).toBeUndefined()
    expect(repository.loadTombstones()).toEqual({ sessionIDs: [removed] })

    await repository.clearTombstones(NOW + 2)
    expect(repository.loadTombstones()).toEqual({ sessionIDs: [] })
  })

  test("does not create segments for sessions that were never stored", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)

    await repository.removeSessions(["ses_missing"], NOW)

    expect(tksKeys(store.dump())).toEqual(["tks.tombstones"])
  })

  test("keeps the 1,000 most recent ids, deduplicated and newest last", async () => {
    const repository = createRepository(createMemoryStore())
    const ids = Array.from({ length: 1_005 }, (_, index) => `ses_${index}`)

    await repository.removeSessions(ids, NOW)

    const tombstones = repository.loadTombstones().sessionIDs
    expect(tombstones.length).toBe(1_000)
    expect(tombstones[0]).toBe("ses_5")
    expect(tombstones.at(-1)).toBe("ses_1004")

    // A repeated removal refreshes recency instead of duplicating the id.
    await repository.removeSessions(["ses_10", "ses_10"], NOW + 1)
    const refreshed = repository.loadTombstones().sessionIDs
    expect(refreshed.length).toBe(1_000)
    expect(refreshed.filter((sessionID) => sessionID === "ses_10").length).toBe(1)
    expect(refreshed.at(-1)).toBe("ses_10")
  })
})

describe("coverage", () => {
  test("round-trips per directory and for all projects in separate keys", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)
    const forDirectory = coverage("/work/a")
    const forAll = coverage(undefined, { recentCatchUpAt: NOW - 1_000 })

    await repository.writeCoverage(forDirectory)
    await repository.writeCoverage(forAll)

    expect(repository.readCoverage("/work/a")).toEqual(forDirectory)
    expect(repository.readCoverage(undefined)).toEqual(forAll)
    expect(repository.readCoverage("/work/b")).toBeUndefined()
    expect(tksKeys(store.dump()).sort()).toEqual(
      ["tks.coverage.all", coverageStorageKey("/work/a"), "tks.coverage-index"].sort(),
    )
  })

  test("keeps both entries when two directory writes overlap", async () => {
    const store = createDeferredStore()
    const repository = createRepository(store)

    // Both calls read the coverage index before either write lands, so the index write that commits
    // second must merge rather than replace: a dropped entry orphans a coverage key that only
    // `clear()` could reach again, leaving a stale watermark behind after a reset.
    await Promise.all([
      repository.writeCoverage(coverage("/work/a")),
      repository.writeCoverage(coverage("/work/b")),
    ])

    expect(repository.readCoverage("/work/a")).toEqual(coverage("/work/a"))
    expect(repository.readCoverage("/work/b")).toEqual(coverage("/work/b"))
    expect((store.dump().get("tks.coverage-index") as { keys: string[] }).keys.sort()).toEqual(
      [coverageStorageKey("/work/a"), coverageStorageKey("/work/b")].sort(),
    )

    await repository.clear()

    expect(repository.readCoverage("/work/a")).toBeUndefined()
    expect(repository.readCoverage("/work/b")).toBeUndefined()
    for (const [key, value] of store.dump()) {
      if (!key.startsWith("tks.")) continue
      expect(Object.keys(value)).toEqual([])
    }
  })

  test("rejects a record whose stored filter does not match its key (hash collision)", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)

    // A 32-bit key can map two directories onto one slot: the payload decides, not the key.
    await seed(store, coverageStorageKey("/work/a"), coverage("/work/other"))

    expect(repository.readCoverage("/work/a")).toBeUndefined()
    expect(repository.readCoverage("/work/other")).toBeUndefined()
  })
})

describe("view snapshots", () => {
  test("are bounded to the eight most recent views", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)

    for (let index = 0; index < 9; index++) {
      await repository.writeViewSnapshot(
        viewSnapshot({ directoryFilter: `/work/${index}`, savedAtMs: NOW + index }),
      )
    }

    expect(repository.readViewSnapshot("/work/0", "last30")).toBeUndefined()
    for (let index = 1; index < 9; index++) {
      expect(repository.readViewSnapshot(`/work/${index}`, "last30")?.savedAtMs).toBe(NOW + index)
    }
    const snapshotKeys = tksKeys(store.dump()).filter((key) => key.startsWith("tks.snapshot.view."))
    expect(snapshotKeys.length).toBe(8)
    expect(repository.readViewSnapshot("/work/8", "last7")).toBeUndefined()
  })

  test("refresh an existing view in place and keep it the most recent", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)

    await repository.writeViewSnapshot(viewSnapshot({ directoryFilter: "/work/a", savedAtMs: NOW }))
    await repository.writeViewSnapshot(viewSnapshot({ directoryFilter: "/work/b", savedAtMs: NOW + 1 }))
    await repository.writeViewSnapshot(viewSnapshot({ directoryFilter: "/work/a", savedAtMs: NOW + 2 }))

    expect(repository.readViewSnapshot("/work/a", "last30")?.savedAtMs).toBe(NOW + 2)
    expect(repository.readViewSnapshot("/work/b", "last30")?.savedAtMs).toBe(NOW + 1)
    expect(tksKeys(store.dump()).filter((key) => key.startsWith("tks.snapshot.view.")).length).toBe(2)

    // Eight views are in the index with `/work/a` refreshed to newest, so `/work/b` is evicted first.
    for (let index = 0; index < 6; index++) {
      await repository.writeViewSnapshot(
        viewSnapshot({ directoryFilter: `/work/c${index}`, savedAtMs: NOW + 3 + index }),
      )
    }
    await repository.writeViewSnapshot(viewSnapshot({ directoryFilter: "/work/d", savedAtMs: NOW + 9 }))

    expect(repository.readViewSnapshot("/work/b", "last30")).toBeUndefined()
    expect(repository.readViewSnapshot("/work/a", "last30")?.savedAtMs).toBe(NOW + 2)
    expect(repository.readViewSnapshot("/work/d", "last30")?.savedAtMs).toBe(NOW + 9)
  })

  test("evicts slots that no longer parse instead of spending the eight-view budget", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)

    for (let index = 0; index < 8; index++) {
      await repository.writeViewSnapshot(
        viewSnapshot({ directoryFilter: `/work/${index}`, savedAtMs: NOW + index }),
      )
    }

    const corrupted = new Set([NOW, NOW + 1, NOW + 2, NOW + 4, NOW + 5, NOW + 6, NOW + 7])
    for (const [key, value] of store.dump()) {
      if (!corrupted.has((value as { savedAtMs?: number }).savedAtMs ?? -1)) continue
      await store.write(key, (draft) => {
        draft.rows = "corrupt"
      })
    }

    expect(repository.readViewSnapshot("/work/0", "last30")).toBeUndefined()

    await repository.writeViewSnapshot(viewSnapshot({ directoryFilter: "/work/8", savedAtMs: NOW + 8 }))

    const index = store.dump().get("tks.snapshots") as { keys: string[] }
    // Only the one readable slot plus the new view remain indexed; the corrupt slots were dropped
    // rather than kept as eight occupied-but-unusable views.
    expect(index.keys.length).toBe(2)
    expect(repository.readViewSnapshot("/work/3", "last30")?.savedAtMs).toBe(NOW + 3)
    expect(repository.readViewSnapshot("/work/8", "last30")?.savedAtMs).toBe(NOW + 8)
  })

  test("returns the newest matching snapshot when two slots hold the same view", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)

    await seed(store, "tks.snapshot.view.0", viewSnapshot({ savedAtMs: NOW }))
    await seed(store, "tks.snapshot.view.1", viewSnapshot({ savedAtMs: NOW + 1 }))
    await seed(store, "tks.snapshots", { keys: ["tks.snapshot.view.0", "tks.snapshot.view.1"] })

    expect(repository.readViewSnapshot("/work/a", "last30")?.savedAtMs).toBe(NOW + 1)
  })
})

describe("widget snapshot", () => {
  test("round-trips rows and reads a corrupt payload as absent", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)

    await repository.writeWidgetSnapshot(widgetRows, NOW)

    expect(repository.readWidgetSnapshot()).toEqual({
      schemaVersion: CACHE_SCHEMA_VERSION,
      metricVersion: METRIC_VERSION,
      rows: widgetRows,
      savedAtMs: NOW,
    })

    await store.write("tks.snapshot.widgetToday", (draft) => {
      draft.rows = "corrupt"
    })
    expect(repository.readWidgetSnapshot()).toBeUndefined()
  })

  test("uses a distinct key and never reads, writes, or clears the legacy 24h snapshot", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)
    const legacy = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      metricVersion: METRIC_VERSION,
      rows: [{ key: "old/m", providerID: "old", modelID: "m", median: 9, calls: 5 }],
      savedAtMs: NOW,
    }
    await store.write("tks.snapshot.widget24h", (draft) => {
      Object.assign(draft, legacy)
    })

    expect(repository.readWidgetSnapshot()).toBeUndefined()

    await repository.writeWidgetSnapshot(widgetRows, NOW + 1)
    expect(store.read("tks.snapshot.widget24h")).toEqual(legacy)
    expect(repository.readWidgetSnapshot()?.rows).toEqual(widgetRows)

    await repository.clear()
    expect(repository.readWidgetSnapshot()).toBeUndefined()
    expect(store.read("tks.snapshot.widget24h")).toEqual(legacy)
  })

  test("writing a snapshot leaves ordinary history records intact", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)
    await repository.putRecords([record("ses_alpha")], NOW)
    await repository.writeWidgetSnapshot(widgetRows, NOW)

    expect(storedSessionIDs(repository)).toEqual(["ses_alpha"])
  })
})

describe("clear", () => {
  test("empties every repository key and leaves foreign data alone", async () => {
    const store = createMemoryStore()
    const repository = createRepository(store)
    const removed = "ses_alpha"

    await repository.putRecords([record(removed), record(sameShardID(removed, "sibling"))], NOW)
    await repository.removeSessions([removed], NOW)
    await repository.writeCoverage(coverage("/work/a"))
    await repository.writeCoverage(coverage(undefined))
    await repository.writeViewSnapshot(viewSnapshot())
    await repository.writeWidgetSnapshot(widgetRows, NOW)
    await store.write("foreign.key", (draft) => {
      draft.keep = "me"
    })

    const before = tksKeys(store.dump())
    expect(before).toContain(coverageStorageKey("/work/a"))

    await repository.clear()

    const after = tksKeys(store.dump())
    expect(after).toEqual(before)
    for (const [key, value] of store.dump()) {
      if (!key.startsWith("tks.")) continue
      // A write-only store cannot delete segments, so a clear leaves empty payloads that every
      // reader treats as absent.
      expect(Object.keys(value)).toEqual([])
    }
    expect(store.dump().get("foreign.key")).toEqual({ keep: "me" })

    expect(repository.loadAllShards().size).toBe(0)
    expect(repository.loadTombstones()).toEqual({ sessionIDs: [] })
    expect(repository.readCoverage("/work/a")).toBeUndefined()
    expect(repository.readCoverage(undefined)).toBeUndefined()
    expect(repository.readViewSnapshot("/work/a", "last30")).toBeUndefined()
    expect(repository.readWidgetSnapshot()).toBeUndefined()
  })

  test("writes nothing on an empty store", async () => {
    const store = createMemoryStore()

    await createRepository(store).clear()

    expect(store.dump().size).toBe(0)
  })
})

function storedSessionIDs(repository: ReturnType<typeof createRepository>): string[] {
  return [...repository.loadAllShards().values()].flatMap((shard) => Object.keys(shard.records))
}
