import { describe, expect, test } from "bun:test"
import { rangeStartMs } from "../../src/filters"
import { collectMeasurements, type SessionMeta } from "../../src/harvest"
import { type HistoryRepository } from "../../src/history/durable"
import { signatureFor } from "../../src/history/records"
import { RECENT_CATCHUP_MS, type ViewState } from "../../src/history/service"
import { comparisonRows } from "../../src/stats"
import {
  createClock,
  createDeferred,
  createService,
  createStore,
  DAY_MS,
  FakeClient,
  fixture,
  measured,
  NOW,
  storedRecords,
  tokens,
  unmeasured,
} from "./harness"

describe("history service acquisition", () => {
  test("cold history publishes partial results progressively, newest first", async () => {
    const client = new FakeClient()
    client.sessions = Array.from({ length: 250 }, (_, index) =>
      fixture(`ses_${String(index).padStart(3, "0")}`, NOW - index * 1_000, [measured(NOW - index * 1_000 - 500)]),
    )
    const clock = createClock(NOW)
    client.scanDelay = () => clock.wait(5)
    // One scan at a time keeps the cold pass longer than two publication intervals.
    const service = createService(client, createStore(), clock, { concurrency: 1 })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })

    const states: ViewState[] = [view()]
    for (let step = 0; step < 400 && states.at(-1)?.kind !== "ready"; step++) {
      await clock.advance(5)
      const next = view()
      if (next !== states.at(-1)) states.push(next)
    }
    release()

    const partials = states.filter((state) => state.kind === "partial")
    expect(partials.length).toBeGreaterThanOrEqual(2)
    // The first publication lands after the first scan, long before the pass completes.
    expect(partials[0].scanned).toBe(1)
    expect(states.findIndex((state) => state.kind === "partial")).toBeLessThan(
      states.findIndex((state) => state.kind === "ready"),
    )
    expect(states.at(-1)?.kind).toBe("ready")
    expect(states.at(-1)?.refreshing).toBe(false)
    expect(states.at(-1)?.lastCheckedAt).toBe(clock.now())
    expect(client.maxInFlight).toBe(1)
    expect(client.messageCalls.map((call) => call.sessionID)).toEqual(
      client.sessions.map((entry) => entry.meta.id),
    )
    expect(service.widget()()).toEqual({
      status: "ready",
      rows: [{ key: "p/m1", providerID: "p", modelID: "m1", median: 10, calls: 250 }],
      stale: false,
    })
  })

  test("a hold with no view drives all-project acquisition that publishes the widget", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500), measured(NOW - 1_600), measured(NOW - 1_700)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)], "/work/b"),
    ]
    const clock = createClock(NOW)
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    await clock.settle()

    // The sidebar-only hold lists every project and scans each session without a view ever opening.
    expect(client.sessionCalls).toHaveLength(1)
    expect(client.sessionCalls[0]?.directory).toBeUndefined()
    expect(client.messageCalls.map((call) => call.sessionID).sort()).toEqual(["ses_a", "ses_b"])
    expect(service.widget()()).toEqual({
      status: "ready",
      rows: [{ key: "p/m1", providerID: "p", modelID: "m1", median: 10, calls: 4 }],
      stale: false,
    })
    release()
  })

  test("warm view makes zero message-list calls", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
      fixture("ses_c", NOW - 3_000, [measured(NOW - 3_500)]),
    ]
    const clock = createClock(NOW)
    const repository = createStore()
    const service = createService(client, repository, clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "last30" })
    await clock.settle()

    expect(view().kind).toBe("ready")
    expect(client.messageCalls).toHaveLength(3)
    expect(repository.readCoverage("/work/a")).toMatchObject({
      fullInventoryCompletedAt: NOW,
      recentCatchUpAt: NOW,
    })

    clock.setNow(NOW + 5 * 60_000)
    service.refreshNow()
    await clock.settle()

    expect(client.messageCalls).toHaveLength(3)
    expect(client.sessionCalls).toHaveLength(2)
    expect(view().kind).toBe("ready")
    expect(view().lastCheckedAt).toBe(NOW + 5 * 60_000)
    expect(view().refreshing).toBe(false)
    // The catch-up moved the watermark without claiming a new inventory.
    expect(repository.readCoverage("/work/a")).toMatchObject({
      fullInventoryCompletedAt: NOW,
      recentCatchUpAt: NOW + 5 * 60_000,
    })

    // Past the inventory interval a full listing runs again, still without rescanning settled sessions.
    clock.setNow(NOW + 11 * 60_000)
    service.refreshNow()
    await clock.settle()

    expect(client.messageCalls).toHaveLength(3)
    expect(repository.readCoverage("/work/a")).toMatchObject({
      fullInventoryCompletedAt: NOW + 11 * 60_000,
      recentCatchUpAt: NOW + 11 * 60_000,
    })
    release()
  })

  test("restart restores the cached view before any network answer", async () => {
    const sessions = () => [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500), measured(NOW - 1_600)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
    ]
    const repository = createStore()
    const clock = createClock(NOW)
    const firstClient = new FakeClient()
    firstClient.sessions = sessions()
    const first = createService(firstClient, repository, clock)
    const firstRelease = first.hold()
    const firstView = first.view({ directory: "/work/a", range: "last30" })
    await clock.settle()
    expect(firstView().kind).toBe("ready")
    const savedRows = comparisonRows(firstView().samples, firstView().unavailable)
    expect(savedRows).toHaveLength(1)
    expect(savedRows[0].calls).toBe(3)
    expect(first.widget()().stale).toBe(false)
    firstRelease()

    const snapshot = repository.readViewSnapshot("/work/a", "last30")
    expect(snapshot?.lastCheckedAt).toBe(NOW)
    expect(snapshot?.rows).toEqual(savedRows)

    const restarted = new FakeClient()
    restarted.sessions = sessions()
    const pendingListing = createDeferred()
    restarted.listingDelay = () => pendingListing.promise
    const clock2 = createClock(NOW + 60_000)
    const second = createService(restarted, repository, clock2)
    const restored = second.view({ directory: "/work/a", range: "last30" })

    expect(restored().kind).toBe("cached")
    expect(restored().lastCheckedAt).toBe(NOW)
    expect(restored().refreshing).toBe(true)
    expect(comparisonRows(restored().samples, restored().unavailable)).toEqual(savedRows)
    expect(restarted.sessionCalls).toHaveLength(0)
    // The widget is served from its durable snapshot, flagged stale until the live pass replaces it.
    expect(second.widget()()).toEqual({
      status: "ready",
      rows: [{ key: "p/m1", providerID: "p", modelID: "m1", median: 10, calls: 3 }],
      stale: true,
    })

    const release = second.hold()
    await clock2.settle()
    expect(restarted.sessionCalls).toHaveLength(1)
    expect(restored().kind).toBe("cached")

    pendingListing.resolve()
    await clock2.settle()
    expect(restored().kind).toBe("ready")
    expect(restarted.messageCalls).toHaveLength(0)
    release()
  })

  test("measurement shards hydrate lazily: none at construction, cached content on first view", async () => {
    const repository = createStore()
    const seedClient = new FakeClient()
    seedClient.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const seedClock = createClock(NOW)
    const seed = createService(seedClient, repository, seedClock)
    const seedRelease = seed.hold()
    seed.view({ directory: "/work/a", range: "last30" })
    await seedClock.settle()
    seedRelease()

    let shardLoads = 0
    const spied: HistoryRepository = {
      ...repository,
      loadAllShards: () => {
        shardLoads += 1
        return repository.loadAllShards()
      },
    }

    const clock = createClock(NOW + 60_000)
    const client = new FakeClient()
    client.sessions = seedClient.sessions
    const service = createService(client, spied, clock)
    // Construction reads the widget snapshot and tombstones, never the measurement shards.
    expect(shardLoads).toBe(0)

    const view = service.view({ directory: "/work/a", range: "last30" })
    // The first view hydrates synchronously, so cached content is available immediately.
    expect(shardLoads).toBe(1)
    expect(view().kind).toBe("cached")
    expect(view().lastCheckedAt).toBe(NOW)
    expect(view().samples).toHaveLength(1)

    // A further view reuses the hydrated shards rather than re-reading them.
    service.view({ directory: "/work/a", range: "last7" })
    expect(shardLoads).toBe(1)
  })

  test("a view recomputes live from an unhydrated repository without rescanning unchanged sessions", async () => {
    const repository = createStore()
    const seedClient = new FakeClient()
    seedClient.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
    ]
    const seedClock = createClock(NOW)
    const seed = createService(seedClient, repository, seedClock)
    const seedRelease = seed.hold()
    seed.view({ directory: "/work/a", range: "last30" })
    await seedClock.settle()
    seedRelease()

    // A new service over the same store hydrates nothing at construction.
    const clock = createClock(NOW + 60_000)
    const client = new FakeClient()
    client.sessions = seedClient.sessions
    const service = createService(client, repository, clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "last30" })
    await clock.settle()

    expect(view().kind).toBe("ready")
    expect(view().samples).toHaveLength(2)
    // The signatures still match, so the lazy hydration skipped every unchanged message scan.
    expect(client.messageCalls).toHaveLength(0)
    release()
  })

  test("only changed sessions are refetched", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
      fixture("ses_c", NOW - 3_000, [measured(NOW - 3_500)]),
    ]
    const clock = createClock(NOW)
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "last30" })
    await clock.settle()
    expect(client.messageCalls).toHaveLength(3)

    client.sessions[1].meta = {
      ...client.sessions[1].meta,
      time: { created: NOW - 60_000, updated: NOW + 1_000 },
      tokens: tokens(40),
    }
    clock.setNow(NOW + 5 * 60_000)
    service.refreshNow()
    await clock.settle()

    expect(client.messageCalls.slice(3).map((call) => call.sessionID)).toEqual(["ses_b"])
    expect(view().kind).toBe("ready")
    release()
  })

  test("empty qualifying session is indexed once", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_empty", NOW - 1_000, [])]
    const clock = createClock(NOW)
    const repository = createStore()
    const service = createService(client, repository, clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()

    expect(client.messageCalls).toHaveLength(1)
    expect(view().kind).toBe("ready")
    expect(view().samples).toHaveLength(0)
    expect(view().scanned).toBe(1)

    for (const offset of [60_000, 120_000]) {
      clock.setNow(NOW + offset)
      service.refreshNow()
      await clock.settle()
    }

    expect(client.messageCalls).toHaveLength(1)
    expect(view().kind).toBe("ready")
    expect(storedRecords(repository)).toMatchObject([
      { sessionID: "ses_empty", complete: true, samples: [], unavailable: [] },
    ])
    release()
  })

  test("quiescent view equals a direct collection for the same scope and range", async () => {
    const sessions = () => [
      fixture("ses_a1", NOW - 3_600_000, [
        measured(NOW - 3_700_000, 10),
        measured(NOW - 3_800_000, 40, "high"),
        unmeasured(NOW - 3_900_000),
      ]),
      fixture("ses_a2", NOW - 2 * DAY_MS, [measured(NOW - 2 * DAY_MS - 1_000, 25)]),
      // Session inside the range whose only request completed outside it.
      fixture("ses_a3", NOW - 3 * DAY_MS, [measured(NOW - 200 * DAY_MS, 99)]),
      fixture("ses_b1", NOW - 3_600_000, [measured(NOW - 3_700_000, 60)], "/work/b"),
    ]
    const directClient = new FakeClient()
    directClient.sessions = sessions()
    const direct = await collectMeasurements(directClient, {
      directory: "/work/a",
      fromMs: rangeStartMs("last30", NOW),
    })

    const client = new FakeClient()
    client.sessions = sessions()
    const clock = createClock(NOW)
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "last30" })
    await clock.settle()

    const state = view()
    expect(state.kind).toBe("ready")
    expect(comparisonRows(state.samples, state.unavailable)).toEqual(
      comparisonRows(direct.samples, direct.unavailable),
    )
    expect(state.variants).toEqual(direct.variants)
    expect(state.samples).toHaveLength(direct.samples.length)
    expect(state.unavailable).toHaveLength(direct.unavailable.length)
    expect(state.samples).toHaveLength(3)
    expect(state.unavailable).toHaveLength(1)
    expect(state.scanned).toBe(3)
    release()
  })

  test("persistence failure is visible and in-memory results still advance", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const failing: HistoryRepository = {
      ...createStore(),
      putRecords: async () => {
        throw new Error("disk full")
      },
    }
    const service = createService(client, failing, clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "last30" })
    await clock.settle()

    expect(view().kind).toBe("ready")
    expect(view().persistence).toBe("unavailable")
    expect(view().samples).toHaveLength(1)
    release()
  })

  test("tombstoned sessions are never published or re-added", async () => {
    const repository = createStore()
    await repository.removeSessions(["ses_gone"], NOW)
    await repository.putRecords(
      [
        {
          sessionID: "ses_gone",
          directory: "/work/a",
          createdAt: NOW - 5_000,
          updatedAt: NOW - 1_000,
          fork: false,
          signature: "stale",
          scannedAtMs: NOW,
          complete: true,
          samples: [{ providerID: "p", modelID: "m1", variant: undefined, rate: 99, completedAt: NOW - 2_000 }],
          unavailable: [],
        },
      ],
      NOW,
    )

    const client = new FakeClient()
    client.sessions = [
      fixture("ses_gone", NOW - 1_000, [measured(NOW - 1_500, 99)]),
      fixture("ses_keep", NOW - 2_000, [measured(NOW - 2_500, 10)]),
    ]
    const clock = createClock(NOW)
    const service = createService(client, repository, clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "last30" })
    await clock.settle()

    const state = view()
    expect(state.kind).toBe("ready")
    expect(state.samples.map((sample) => sample.rate)).toEqual([10])
    expect(state.scanned).toBe(1)
    expect(client.messageCalls.map((call) => call.sessionID)).toEqual(["ses_keep"])
    expect(repository.loadTombstones().sessionIDs).toEqual(["ses_gone"])
    // The stale durable copy is left for the deletion layer; the service neither republishes nor rewrites it.
    const tombstoned = storedRecords(repository).find((record) => record.sessionID === "ses_gone")
    expect(tombstoned?.signature).toBe("stale")
    expect(storedRecords(repository).map((record) => record.sessionID).sort()).toEqual(["ses_gone", "ses_keep"])
    release()
  })

  test("a metadata change during a scan publishes it and requeues the session once", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const scan = createDeferred()
    client.scanDelay = () => scan.promise
    const repository = createStore()
    const service = createService(client, repository, clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(client.messageCalls).toHaveLength(1)

    const updated: SessionMeta = {
      ...client.sessions[0].meta,
      time: { created: NOW - 1_000, updated: NOW },
      tokens: tokens(40),
    }
    client.sessions[0].meta = updated
    scan.resolve()
    await clock.settle()

    expect(client.messageCalls).toHaveLength(2)
    expect(view().kind).toBe("ready")
    expect(storedRecords(repository).map((record) => record.signature)).toEqual([signatureFor(updated)])
    release()
  })

  test("a failed pass is reported, retains data, and retries on the next tick", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [
        measured(NOW - 1_500),
        measured(NOW - 1_600),
        measured(NOW - 1_700),
      ]),
    ]
    const clock = createClock(NOW)
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "last30" })
    await clock.settle()
    expect(view().kind).toBe("ready")
    const rows = service.widget()().rows
    expect(rows).toHaveLength(1)

    client.failListing = true
    service.refreshNow()
    await clock.settle()

    expect(view()).toMatchObject({
      kind: "error",
      refreshFailed: true,
      refreshing: true,
      lastCheckedAt: NOW,
    })
    // The previous data stays visible and the widget keeps its rows, flagged stale.
    expect(view().samples).toHaveLength(3)
    expect(service.widget()()).toEqual({ status: "ready", rows, stale: true })

    const attempts = client.sessionCalls.length
    client.failListing = false
    await clock.advance(RECENT_CATCHUP_MS)

    expect(client.sessionCalls.length).toBeGreaterThan(attempts)
    expect(view().kind).toBe("ready")
    expect(view().refreshFailed).toBe(false)
    expect(view().refreshing).toBe(false)
    expect(view().lastCheckedAt).toBe(clock.now())
    release()

    // A first pass that never succeeds is an error, not an empty result.
    const failingClient = new FakeClient()
    failingClient.failListing = true
    const coldClock = createClock(NOW)
    const failing = createService(failingClient, createStore(), coldClock)
    const failingRelease = failing.hold()
    const failingView = failing.view({ directory: "/work/a", range: "last30" })
    await coldClock.settle()

    expect(failingView()).toMatchObject({
      kind: "error",
      refreshFailed: true,
      refreshing: true,
      lastCheckedAt: undefined,
      scanned: 0,
    })
    expect(failingView().samples).toHaveLength(0)
    expect(failing.widget()()).toEqual({ status: "error", rows: [], stale: false })
    failingRelease()
  })

  test("a failed catch-up does not advance the watermark", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const repository = createStore()
    const service = createService(client, repository, clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(view().kind).toBe("ready")
    expect(repository.readCoverage("/work/a")).toMatchObject({
      fullInventoryCompletedAt: NOW,
      recentCatchUpAt: NOW,
    })

    client.failListing = true
    clock.setNow(NOW + RECENT_CATCHUP_MS)
    service.refreshNow()
    await clock.settle()

    // The failed catch-up reported the error but never claimed new coverage.
    expect(view().refreshFailed).toBe(true)
    expect(repository.readCoverage("/work/a")).toMatchObject({
      fullInventoryCompletedAt: NOW,
      recentCatchUpAt: NOW,
    })
    release()
  })

  test("catch-up listing stops at the watermark without re-reading stale pages", async () => {
    // 201 sessions span three 100-session pages; every one is older than the watermark.
    const client = new FakeClient()
    client.sessions = Array.from({ length: 201 }, (_, index) =>
      fixture(`ses_${String(index).padStart(3, "0")}`, NOW - (index + 1) * 1_000, []),
    )
    const clock = createClock(NOW)
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(view().kind).toBe("ready")
    // The full inventory listed every page (100 + 100 + 1 sessions).
    expect(client.sessionCalls).toHaveLength(3)

    clock.setNow(NOW + RECENT_CATCHUP_MS)
    service.refreshNow()
    await clock.settle()

    // The catch-up starts from the watermark; every session is older, so it stops
    // after the first page instead of re-reading the stale remaining pages.
    expect(client.sessionCalls).toHaveLength(4)
    release()
  })

  test("reset clears durable state and rebuilds from a fresh inventory", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const repository = createStore()
    const service = createService(client, repository, clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "last30" })
    await clock.settle()
    expect(view().kind).toBe("ready")
    expect(client.messageCalls).toHaveLength(1)

    const reset = service.reset()
    expect(view().kind).toBe("loading")
    expect(view().samples).toHaveLength(0)
    await reset
    expect(storedRecords(repository)).toHaveLength(0)

    await clock.settle()
    expect(view().kind).toBe("ready")
    expect(view().samples).toHaveLength(1)
    expect(client.messageCalls).toHaveLength(2)
    release()
  })
})
