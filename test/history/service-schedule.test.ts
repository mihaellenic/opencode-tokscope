import { describe, expect, test } from "bun:test"
import { createMemoryStore, createRepository } from "../../src/history/durable"
import { signatureFor } from "../../src/history/records"
import {
  AUDIT_BATCH_SESSIONS,
  AUDIT_INTERVAL_MS,
  DIRTY_DEBOUNCE_MS,
  INVENTORY_MIN_INTERVAL_MS,
  MAX_SCHEDULE_DELAY_MS,
  PUBLISH_INTERVAL_MS,
  RECENT_CATCHUP_MS,
} from "../../src/history/service"
import {
  createClock,
  createDeferred,
  createEventSource,
  createLog,
  createService,
  createStore,
  FakeClient,
  fixture,
  measured,
  NOW,
  storedRecords,
} from "./harness"

const scannedIds = (client: FakeClient, from = 0): string[] =>
  client.messageCalls.slice(from).map((call) => call.sessionID)

describe("history service scheduling", () => {
  test("event burst coalesces to one revision per session", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
    ]
    const clock = createClock(NOW)
    const events = createEventSource()
    const service = createService(client, createStore(), clock, { subscribeEvents: events.subscribe })
    const release = service.hold()
    service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(client.messageCalls).toHaveLength(2)
    expect(events.subscribed()).toBe(1)

    // Streaming and tool chatter never schedules acquisition.
    for (const type of ["session.text.delta", "session.tool.progress", "session.step.started"]) {
      events.emit(type, "ses_a")
    }
    await clock.advance(MAX_SCHEDULE_DELAY_MS)
    expect(client.messageCalls).toHaveLength(2)

    events.emit("session.step.ended", "ses_a")
    await clock.advance(100)
    events.emit("session.execution.succeeded", "ses_a")
    await clock.advance(100)
    events.emit("session.usage.recorded", "ses_b")
    await clock.advance(100)
    // Every event restarted the debounce window, so the burst has not flushed yet.
    expect(client.messageCalls).toHaveLength(2)

    await clock.advance(DIRTY_DEBOUNCE_MS)
    expect(scannedIds(client, 2).sort()).toEqual(["ses_a", "ses_b"])
    expect(client.messageCalls).toHaveLength(4)
    release()
  })

  test("every dirty event type schedules a scan", async () => {
    const dirtyEvents = [
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
    ]
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const events = createEventSource()
    const service = createService(client, createStore(), clock, { subscribeEvents: events.subscribe })
    const release = service.hold()
    service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(client.messageCalls).toHaveLength(1)

    for (const [index, type] of dirtyEvents.entries()) {
      events.emit(type, "ses_a")
      await clock.advance(DIRTY_DEBOUNCE_MS)
      expect(client.messageCalls).toHaveLength(2 + index)
    }
    release()
  })

  test("a continuous event stream flushes at the maximum scheduling delay", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const events = createEventSource()
    const service = createService(client, createStore(), clock, { subscribeEvents: events.subscribe })
    const release = service.hold()
    service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(client.messageCalls).toHaveLength(1)

    for (let step = 0; step < 10; step++) {
      events.emit("session.step.ended", "ses_a")
      await clock.advance(100)
    }

    // A stream that keeps resetting the debounce still flushes once, one second after the first event.
    expect(clock.now()).toBe(NOW + MAX_SCHEDULE_DELAY_MS)
    expect(client.messageCalls).toHaveLength(2)
    release()
  })

  test("step.ended triggers a scan of only that session", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
      fixture("ses_c", NOW - 3_000, [measured(NOW - 3_500)]),
    ]
    const clock = createClock(NOW)
    const events = createEventSource()
    const service = createService(client, createStore(), clock, { subscribeEvents: events.subscribe })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(view().kind).toBe("ready")
    expect(client.messageCalls).toHaveLength(3)

    events.emit("session.step.ended", "ses_b")
    await clock.advance(DIRTY_DEBOUNCE_MS)

    expect(scannedIds(client, 3)).toEqual(["ses_b"])
    expect(view().refreshing).toBe(true)
    expect(view().kind).toBe("partial")

    // The next scheduled catch-up certifies the settled view again.
    await clock.advance(RECENT_CATCHUP_MS)
    expect(view().kind).toBe("ready")
    expect(view().refreshing).toBe(false)
    release()
  })

  test("deleted during an in-flight scan does not resurrect the record", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const events = createEventSource()
    const repository = createStore()
    const service = createService(client, repository, clock, { subscribeEvents: events.subscribe })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(view().kind).toBe("ready")
    expect(storedRecords(repository)).toHaveLength(1)

    const scan = createDeferred()
    client.scanDelay = () => scan.promise
    events.emit("session.step.ended", "ses_a")
    await clock.advance(DIRTY_DEBOUNCE_MS)
    expect(client.messageCalls).toHaveLength(2)

    events.emit("session.deleted", "ses_a")
    await clock.settle()

    expect(repository.loadTombstones().sessionIDs).toEqual(["ses_a"])
    expect(storedRecords(repository)).toHaveLength(0)
    expect(view().samples).toHaveLength(0)

    // The scan finishes after the deletion: its result must be discarded, not written back.
    scan.resolve()
    await clock.settle()
    client.scanDelay = undefined

    expect(storedRecords(repository)).toHaveLength(0)
    expect(view().samples).toHaveLength(0)

    // A later listing that still advertises the session does not re-add it either.
    service.refreshNow()
    await clock.settle()
    expect(client.messageCalls).toHaveLength(2)
    expect(storedRecords(repository)).toHaveLength(0)
    expect(repository.loadTombstones().sessionIDs).toEqual(["ses_a"])
    release()
  })

  test("a scan that predates a cleared tombstone is still discarded", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const events = createEventSource()
    const repository = createStore()
    const service = createService(client, repository, clock, { subscribeEvents: events.subscribe })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(storedRecords(repository)).toHaveLength(1)

    const scan = createDeferred()
    client.scanDelay = () => scan.promise
    events.emit("session.step.ended", "ses_a")
    await clock.advance(DIRTY_DEBOUNCE_MS)
    expect(client.messageCalls).toHaveLength(2)

    events.emit("session.deleted", "ses_a")
    await clock.settle()
    expect(repository.loadTombstones().sessionIDs).toEqual(["ses_a"])

    // The server confirms the deletion, so the next verified inventory releases the tombstone while
    // the pre-deletion scan is still in flight.
    client.sessions = []
    client.scanDelay = undefined
    clock.setNow(NOW + DIRTY_DEBOUNCE_MS + INVENTORY_MIN_INTERVAL_MS + 1)
    service.refreshNow()
    await clock.settle()
    expect(repository.loadTombstones().sessionIDs).toEqual([])

    // Its own scan generation, not the tombstone, is what keeps the obsolete result out of the cache.
    scan.resolve()
    await clock.advance(PUBLISH_INTERVAL_MS)
    expect(storedRecords(repository)).toHaveLength(0)
    expect(view().samples).toHaveLength(0)
    release()
  })

  test("inventory verification removes a record that session.get reports missing", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
    ]
    const clock = createClock(NOW)
    const repository = createStore()
    const service = createService(client, repository, clock)
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(storedRecords(repository)).toHaveLength(2)

    // The session vanished between inventories: absent from the listing, 404 from `session.get`.
    client.sessions = client.sessions.filter((entry) => entry.meta.id !== "ses_b")
    clock.setNow(NOW + INVENTORY_MIN_INTERVAL_MS + 1)
    service.refreshNow()
    await clock.settle()

    expect(view().scanned).toBe(1)
    expect(view().samples).toHaveLength(1)
    expect(storedRecords(repository).map((record) => record.sessionID)).toEqual(["ses_a"])
    expect(repository.loadTombstones().sessionIDs).toEqual(["ses_b"])
    release()
  })

  test("failed verification keeps the record", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
    ]
    const clock = createClock(NOW)
    const repository = createStore()
    const { events, log } = createLog()
    const service = createService(client, repository, clock, { log })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(storedRecords(repository)).toHaveLength(2)

    // The listing omits the session, but the individual check fails for a reason other than 404.
    client.sessions = client.sessions.filter((entry) => entry.meta.id !== "ses_b")
    client.getErrors.add("ses_b")
    clock.setNow(NOW + INVENTORY_MIN_INTERVAL_MS + 1)
    service.refreshNow()
    await clock.settle()

    // The inventory is inside its first retry wait here, so the invariant is a mid-retry one and no
    // failure has been reported yet.
    expect(events.filter((event) => event.operation === "inventory").at(-1)).toMatchObject({
      outcome: "retry",
      attempt: 1,
    })
    expect(view().refreshFailed).toBe(false)
    expect(view().scanned).toBe(2)
    expect(view().samples).toHaveLength(2)
    expect(storedRecords(repository).map((record) => record.sessionID).sort()).toEqual(["ses_a", "ses_b"])
    expect(repository.loadTombstones().sessionIDs).toEqual([])
    release()
  })

  test("a verified inventory releases tombstoned sessions that are confirmed gone", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
    ]
    const clock = createClock(NOW)
    const events = createEventSource()
    const repository = createStore()
    const service = createService(client, repository, clock, { subscribeEvents: events.subscribe })
    const release = service.hold()
    service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(storedRecords(repository)).toHaveLength(2)

    events.emit("session.deleted", "ses_b")
    await clock.settle()
    expect(repository.loadTombstones().sessionIDs).toEqual(["ses_b"])

    // The server confirms the deletion, so the next full inventory can release the marker.
    client.sessions = client.sessions.filter((entry) => entry.meta.id !== "ses_b")
    clock.setNow(NOW + INVENTORY_MIN_INTERVAL_MS + 1)
    service.refreshNow()
    await clock.settle()

    expect(storedRecords(repository).map((record) => record.sessionID)).toEqual(["ses_a"])
    expect(repository.loadTombstones().sessionIDs).toEqual([])
    release()
  })

  test("same-signature changes are found by audit rotation", async () => {
    const client = new FakeClient()
    const sessions = Array.from({ length: AUDIT_BATCH_SESSIONS + 5 }, (_, index) =>
      fixture(`ses_${String(index).padStart(2, "0")}`, NOW - index * 1_000, [
        measured(NOW - index * 1_000 - 500),
      ]),
    )
    client.sessions = sessions
    const clock = createClock(NOW)
    const repository = createStore()
    const service = createService(client, repository, clock, { concurrency: 4 })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(view().kind).toBe("ready")
    const initial = client.messageCalls.length
    expect(initial).toBe(sessions.length)

    // Content-only changes leave every metadata signature untouched.
    const signatures = new Map(sessions.map((entry) => [entry.meta.id, signatureFor(entry.meta)]))
    for (const entry of client.sessions) {
      entry.messages = [measured(entry.meta.time.updated - 500, 40)]
    }

    let audited = 0
    for (let tick = 0; tick < Math.ceil(sessions.length / AUDIT_BATCH_SESSIONS); tick++) {
      await clock.advance(AUDIT_INTERVAL_MS)
      const scans = client.messageCalls.length - initial - audited
      expect(scans).toBeGreaterThan(0)
      expect(scans).toBeLessThanOrEqual(AUDIT_BATCH_SESSIONS)
      audited += scans
    }

    for (const record of storedRecords(repository)) {
      expect(record.signature).toBe(signatures.get(record.sessionID) ?? "")
      expect(record.samples.map((sample) => sample.rate)).toEqual([40])
    }
    expect(storedRecords(repository)).toHaveLength(sessions.length)
    release()
  })

  test("sustained rewrites do not loop", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const events = createEventSource()
    // Every completed scan is immediately followed by a new event for the same session.
    client.onScan = () => events.emit("session.step.ended", "ses_a")
    const service = createService(client, createStore(), clock, {
      subscribeEvents: events.subscribe,
      concurrency: 1,
    })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(client.messageCalls).toHaveLength(1)

    let previous = client.messageCalls.length
    for (let interval = 0; interval < 6; interval++) {
      await clock.advance(DIRTY_DEBOUNCE_MS)
      const scans = client.messageCalls.length - previous
      previous = client.messageCalls.length
      // One debounce window admits at most one scan (plus the pass scan), never a synchronous loop.
      expect(scans).toBeLessThanOrEqual(2)
      expect(scans).toBeGreaterThanOrEqual(1)
      expect(view().refreshing).toBe(true)
      expect(view().kind).toBe("partial")
    }
    expect(client.messageCalls.length).toBeLessThanOrEqual(1 + 6 * 2)
    release()
  })

  test("no holds pause all timers", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const events = createEventSource()
    const service = createService(client, createStore(), clock, { subscribeEvents: events.subscribe })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(client.messageCalls).toHaveLength(1)

    release()
    const scans = client.messageCalls.length
    const listings = client.sessionCalls.length
    // Releasing the last consumer clears every timer (catch-up, audit, debounce, publication).
    expect(clock.pending()).toBe(0)
    // Marks recorded while unattached survive, but no timer and no scan starts.
    events.emit("session.step.ended", "ses_a")
    await clock.advance(5 * RECENT_CATCHUP_MS)
    expect(client.messageCalls).toHaveLength(scans)
    expect(client.sessionCalls).toHaveLength(listings)
    expect(clock.pending()).toBe(0)

    const again = service.hold()
    await clock.advance(DIRTY_DEBOUNCE_MS)
    expect(scannedIds(client, scans)).toEqual(["ses_a"])

    await clock.advance(RECENT_CATCHUP_MS)
    expect(client.sessionCalls.length).toBeGreaterThan(listings)
    expect(view().kind).toBe("ready")
    again()
  })

  test("reset discards an in-flight scan from before the reset", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const events = createEventSource()
    const repository = createStore()
    const service = createService(client, repository, clock, { subscribeEvents: events.subscribe })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(storedRecords(repository)).toHaveLength(1)

    const scan = createDeferred()
    client.scanDelay = () => scan.promise
    events.emit("session.step.ended", "ses_a")
    await clock.advance(DIRTY_DEBOUNCE_MS)
    expect(client.messageCalls).toHaveLength(2)

    // The pass the reset schedules cannot write, so any stored record would come from the stale scan.
    client.failListing = true
    const reset = service.reset()
    await reset
    expect(storedRecords(repository)).toHaveLength(0)

    scan.resolve()
    await clock.settle()
    await clock.advance(RECENT_CATCHUP_MS)

    expect(storedRecords(repository)).toHaveLength(0)
    expect(view().kind).toBe("error")
    release()
  })

  test("refreshNow coalesces into a single listing pass", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(client.sessionCalls).toHaveLength(1)

    const listing = createDeferred()
    client.listingDelay = () => listing.promise
    service.refreshNow()
    service.refreshNow()
    await clock.settle()
    expect(client.sessionCalls).toHaveLength(2)

    client.listingDelay = undefined
    listing.resolve()
    await clock.settle()
    expect(client.sessionCalls).toHaveLength(3)
    release()
  })
})

const local = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number =>
  new Date(year, month - 1, day, hour, minute, second).getTime()

const ROWS_3 = (calls: number) => [{ key: "p/m1", providerID: "p", modelID: "m1", median: 10, calls }]

/** Three qualifying calls completed at `completedAt` (minus a few ms to stay distinct). */
const threeCalls = (completedAt: number) => [
  measured(completedAt),
  measured(completedAt - 10),
  measured(completedAt - 20),
]

describe("sidebar today snapshot and rollover", () => {
  const widgetRow = { key: "p/m1", providerID: "p", modelID: "m1", median: 10, calls: 3 }

  test("a same-day snapshot restores; previous-day, future, and legacy snapshots do not", async () => {
    const at = local(2026, 5, 10, 12, 0)
    const cases: { name: string; savedAtMs: number; restored: boolean }[] = [
      { name: "same day", savedAtMs: local(2026, 5, 10, 9, 0), restored: true },
      { name: "exactly midnight", savedAtMs: local(2026, 5, 10, 0, 0), restored: true },
      { name: "one ms before midnight", savedAtMs: local(2026, 5, 10, 0, 0) - 1, restored: false },
      { name: "previous day", savedAtMs: local(2026, 5, 9, 23, 0), restored: false },
      { name: "future", savedAtMs: at + 1, restored: false },
    ]
    for (const entry of cases) {
      const repository = createStore()
      await repository.writeWidgetSnapshot([widgetRow], entry.savedAtMs)
      const service = createService(new FakeClient(), repository, createClock(at))
      expect(service.widget()().status, entry.name).toBe(entry.restored ? "ready" : "loading")
      expect(service.widget()().rows, entry.name).toEqual(entry.restored ? [widgetRow] : [])
    }
  })

  test("a legacy 24h snapshot is ignored and left in place", async () => {
    const at = local(2026, 5, 10, 12, 0)
    const store = createMemoryStore()
    const legacy = {
      schemaVersion: createRepository(store).readWidgetSnapshot()?.schemaVersion,
      rows: [widgetRow],
      savedAtMs: at - 1_000,
    }
    await store.write("tks.snapshot.widget24h", (draft) => {
      Object.assign(draft, legacy)
    })
    const repository = createRepository(store)
    const service = createService(new FakeClient(), repository, createClock(at))

    expect(service.widget()().status).toBe("loading")
    expect(store.read("tks.snapshot.widget24h")).toEqual(legacy)
    expect(repository.readWidgetSnapshot()).toBeUndefined()
  })

  test("a stalled acquisition across midnight drops yesterday's rows", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", local(2026, 5, 10, 23, 50), threeCalls(local(2026, 5, 10, 23, 50)))]
    const clock = createClock(local(2026, 5, 10, 23, 58, 30))
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    await clock.settle()
    expect(service.widget()()).toEqual({ status: "ready", rows: ROWS_3(3), stale: false })

    // Listing and the audit's message reads both hang, so only the timer rollover can clear rows.
    const stall = createDeferred()
    client.listingDelay = () => stall.promise
    client.scanDelay = () => stall.promise
    await clock.advance(60_000)
    // Still 23:59:30: same-day rows survive the stalled refresh.
    expect(service.widget()().rows).toEqual(ROWS_3(3))

    await clock.advance(60_000)
    expect(clock.now()).toBe(local(2026, 5, 11, 0, 0, 30))
    // The catch-up tick rolls the widget over before (and independently of) the stalled listing.
    expect(service.widget()().status).toBe("ready")
    expect(service.widget()().rows).toEqual([])
    expect(client.sessionCalls.length).toBeGreaterThan(0)

    stall.resolve()
    await clock.settle()
    expect(service.widget()()).toEqual({ status: "ready", rows: [], stale: false })
    release()
  })

  test("a reset across midnight with a stalled acquisition stays loading, not ready empty", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", local(2026, 5, 10, 23, 50), threeCalls(local(2026, 5, 10, 23, 50)))]
    const clock = createClock(local(2026, 5, 10, 23, 59))
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    await clock.settle()
    expect(service.widget()().rows).toEqual(ROWS_3(3))

    clock.setNow(local(2026, 5, 11, 0, 0, 5))
    client.listingDelay = () => createDeferred().promise
    await service.reset()
    expect(service.widget()()).toEqual({ status: "loading", rows: [], stale: false })

    await clock.advance(RECENT_CATCHUP_MS)
    expect(service.widget()()).toEqual({ status: "loading", rows: [], stale: false })
    release()
  })

  test("a reset before first hydration never loads pre-clear records for a concurrent view", async () => {
    const seedClient = new FakeClient()
    seedClient.sessions = [fixture("ses_a", local(2026, 5, 10, 12, 0), threeCalls(local(2026, 5, 10, 12, 0)))]
    const repository = createStore()
    const seedClock = createClock(local(2026, 5, 10, 12, 30))
    const seed = createService(seedClient, repository, seedClock)
    const seedRelease = seed.hold()
    await seedClock.settle()
    expect(storedRecords(repository)).toHaveLength(1)
    seedRelease()

    // A fresh process: nothing hydrated yet, and the listing never lands.
    const client = new FakeClient()
    client.listingDelay = () => createDeferred().promise
    const clock = createClock(local(2026, 5, 10, 12, 30))
    const service = createService(client, repository, clock)
    const reset = service.reset()
    const view = service.view({ directory: "/work/a", range: "all" })
    await reset
    await clock.settle()

    expect(view().samples).toEqual([])
    expect(view().kind).toBe("loading")
    expect(storedRecords(repository)).toHaveLength(0)
  })

  test("a reset before first hydration with a stalled pass stays loading across midnight", async () => {
    const seedClient = new FakeClient()
    seedClient.sessions = [fixture("ses_a", local(2026, 5, 10, 23, 50), threeCalls(local(2026, 5, 10, 23, 50)))]
    const repository = createStore()
    const seedClock = createClock(local(2026, 5, 10, 23, 59))
    const seed = createService(seedClient, repository, seedClock)
    const seedRelease = seed.hold()
    await seedClock.settle()
    seedRelease()

    const client = new FakeClient()
    client.listingDelay = () => createDeferred().promise
    const clock = createClock(local(2026, 5, 10, 23, 59))
    const service = createService(client, repository, clock)
    const release = service.hold()
    await service.reset()
    clock.setNow(local(2026, 5, 11, 0, 0, 5))
    await clock.advance(RECENT_CATCHUP_MS)

    expect(service.widget()()).toEqual({ status: "loading", rows: [], stale: false })
    release()
  })

  test("a same-day backwards clock jump drops rows that are now in the future", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", local(2026, 5, 10, 12, 0), threeCalls(local(2026, 5, 10, 12, 0)))]
    const clock = createClock(local(2026, 5, 10, 12, 30))
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    await clock.settle()
    expect(service.widget()().rows).toEqual(ROWS_3(3))

    // The fake clock's timers are absolute, so reattachment (which also checks the rollover) is the
    // deterministic way to observe the check after the jump.
    release()
    client.listingDelay = () => createDeferred().promise
    client.scanDelay = () => createDeferred().promise
    clock.setNow(local(2026, 5, 10, 10, 0))
    const again = service.hold()
    expect(service.widget()()).toEqual({ status: "ready", rows: [], stale: true })
    again()
  })

  test("a failing acquisition across midnight cannot restore yesterday's rows", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", local(2026, 5, 10, 23, 50), threeCalls(local(2026, 5, 10, 23, 50)))]
    const clock = createClock(local(2026, 5, 10, 23, 58, 30))
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    await clock.settle()
    expect(service.widget()().rows).toEqual(ROWS_3(3))

    client.failListing = true
    client.scanErrors.add("ses_a")
    await clock.advance(60_000)
    await clock.advance(5_000)
    // Same-day failure (retries exhausted) keeps same-day rows.
    expect(service.widget()().status).toBe("ready")
    expect(service.widget()().rows).toEqual(ROWS_3(3))

    await clock.advance(120_000)
    expect(clock.now()).toBeGreaterThan(local(2026, 5, 11))
    expect(client.sessionCalls.length).toBeGreaterThan(3)
    expect(service.widget()().rows).toEqual([])
    expect(service.widget()().status).toBe("ready")
    release()
  })

  test("rollover projects today's already-hydrated samples while acquisition is stalled", async () => {
    // Calls stamped 00:00:10 are future-dated (hence excluded) until the clock passes midnight.
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", local(2026, 5, 11, 0, 0, 10), [
        ...threeCalls(local(2026, 5, 10, 23, 50)),
        ...threeCalls(local(2026, 5, 11, 0, 0, 10)),
      ]),
    ]
    const clock = createClock(local(2026, 5, 10, 23, 59, 40))
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    await clock.settle()
    expect(service.widget()().rows).toEqual(ROWS_3(3))

    client.listingDelay = () => createDeferred().promise
    await clock.advance(60_000)
    expect(clock.now()).toBeGreaterThan(local(2026, 5, 11))
    expect(service.widget()().rows).toEqual(ROWS_3(3))
    release()
  })

  test("a stopped timer does not roll over, but reattachment does before any acquisition", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", local(2026, 5, 10, 23, 50), threeCalls(local(2026, 5, 10, 23, 50)))]
    const clock = createClock(local(2026, 5, 10, 23, 58))
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    await clock.settle()
    release()
    expect(clock.pending()).toBe(0)

    clock.setNow(local(2026, 5, 11, 8, 0))
    await clock.settle()
    expect(service.widget()().rows).toEqual(ROWS_3(3))

    client.listingDelay = () => createDeferred().promise
    const again = service.hold()
    expect(service.widget()()).toEqual({ status: "ready", rows: [], stale: true })
    again()
  })

  test("reattachment without hydrated records reverts to loading, then reports an error on failure", async () => {
    const repository = createStore()
    await repository.writeWidgetSnapshot([widgetRow], local(2026, 5, 10, 23, 0))
    const client = new FakeClient()
    client.failListing = true
    const clock = createClock(local(2026, 5, 10, 23, 30))
    const service = createService(client, repository, clock)
    expect(service.widget()().rows).toEqual([widgetRow])

    clock.setNow(local(2026, 5, 11, 0, 5))
    const release = service.hold()
    expect(service.widget()().rows).toEqual([])
    await clock.advance(5_000)
    expect(service.widget()()).toEqual({ status: "error", rows: [], stale: false })
    release()
  })

  test("DST: the short spring day rolls over at calendar midnight, not 24h after publication", async () => {
    // Meaningful under TZ=America/New_York (2026-03-08 has 23 hours); valid in any zone.
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", local(2026, 3, 8, 0, 5), threeCalls(local(2026, 3, 8, 0, 5)))]
    const clock = createClock(local(2026, 3, 8, 0, 10))
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    await clock.settle()
    expect(service.widget()().rows).toEqual(ROWS_3(3))
    release()

    // 23:30 the same calendar day: fewer than 24h after the call regardless of the zone.
    clock.setNow(local(2026, 3, 8, 23, 30))
    const sameDay = service.hold()
    expect(service.widget()().rows).toEqual(ROWS_3(3))
    sameDay()

    // Calendar midnight of 03-09 may be only 23h after 03-08 00:10; yesterday's rows must go.
    clock.setNow(local(2026, 3, 9, 0, 0))
    client.listingDelay = () => createDeferred().promise
    const next = service.hold()
    expect(service.widget()().rows).toEqual([])
    next()
  })

  test("DST: the long autumn day keeps a call from its first hour until its midnight", async () => {
    // 2026-11-01 has 25 hours under TZ=America/New_York: 00:30 is more than 24h before 23:45.
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", local(2026, 11, 1, 0, 30), threeCalls(local(2026, 11, 1, 0, 30)))]
    const clock = createClock(local(2026, 11, 1, 0, 40))
    const service = createService(client, createStore(), clock)
    const release = service.hold()
    await clock.settle()
    expect(service.widget()().rows).toEqual(ROWS_3(3))
    release()

    clock.setNow(local(2026, 11, 1, 23, 45))
    const again = service.hold()
    await clock.settle()
    expect(service.widget()()).toEqual({ status: "ready", rows: ROWS_3(3), stale: false })
    again()

    clock.setNow(local(2026, 11, 2, 0, 0))
    client.listingDelay = () => createDeferred().promise
    const next = service.hold()
    expect(service.widget()().rows).toEqual([])
    next()
  })
})
