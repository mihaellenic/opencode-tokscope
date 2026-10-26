import { describe, expect, test } from "bun:test"
import type { HistoryRepository } from "../../src/history/durable"
import {
  ACQUISITION_RETRY_DELAYS_MS,
  AUDIT_INTERVAL_MS,
  DIRTY_DEBOUNCE_MS,
  INVENTORY_MIN_INTERVAL_MS,
  type HistoryLogEvent,
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

const operations = (events: HistoryLogEvent[], operation: HistoryLogEvent["operation"]) =>
  events.filter((event) => event.operation === operation).map((event) => [event.outcome, event.attempt])

const retryWindowMs = ACQUISITION_RETRY_DELAYS_MS.reduce((total, wait) => total + wait, 0)

describe("history service diagnostics", () => {
  test("inventory runs only when coverage is missing or strictly older than thirty minutes", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, createStore(), clock, { log })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(view().kind).toBe("ready")
    expect(INVENTORY_MIN_INTERVAL_MS).toBe(1_800_000)
    expect(events.map((event) => event.operation)).toEqual(["hydrate", "inventory"])

    // Exactly thirty minutes is a catch-up: the comparison stays strict.
    clock.setNow(NOW + INVENTORY_MIN_INTERVAL_MS)
    service.refreshNow()
    await clock.settle()
    expect(events.map((event) => event.operation)).toEqual(["hydrate", "inventory", "catch-up"])

    clock.setNow(NOW + INVENTORY_MIN_INTERVAL_MS + 1)
    service.refreshNow()
    await clock.settle()
    expect(events.map((event) => event.operation)).toEqual(["hydrate", "inventory", "catch-up", "inventory"])
    release()
  })

  test("a successful acquisition logs its duration and the records it actually read", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500), measured(NOW - 1_600)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
    ]
    const clock = createClock(NOW)
    client.listingDelay = () => clock.wait(7)
    const { events, log } = createLog()
    const service = createService(client, createStore(), clock, { log })
    const release = service.hold()
    service.view({ directory: "/work/a", range: "all" })
    await clock.advance(7)

    // Hydration is timed but reads nothing through the client.
    expect(events[0]).toEqual({
      operation: "hydrate",
      outcome: "success",
      durationMs: 0,
      attempt: 1,
      sessionsRead: 0,
      messagesRead: 0,
    })
    // One listing page of two sessions, two metadata re-reads per scan, three message records in total.
    expect(events[1]).toEqual({
      operation: "inventory",
      outcome: "success",
      durationMs: 7,
      attempt: 1,
      sessionsRead: 6,
      messagesRead: 3,
    })
    release()
  })

  test("record counts follow returned records, not API pages", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture(
        "ses_a",
        NOW - 1_000,
        Array.from({ length: 250 }, (_, index) => measured(NOW - 1_500 - index)),
      ),
    ]
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, createStore(), clock, { log })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()

    expect(view().kind).toBe("ready")
    expect(client.messageCalls).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({
      operation: "inventory",
      outcome: "success",
      sessionsRead: 3,
      messagesRead: 250,
    })
    release()
  })

  test("a failed attempt is retried after one and three seconds and can still succeed", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    client.listingFailures = 2
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, createStore(), clock, { log })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()

    expect(operations(events, "inventory")).toEqual([["retry", 1]])
    expect(view().kind).toBe("loading")

    await clock.advance(ACQUISITION_RETRY_DELAYS_MS[0])
    expect(operations(events, "inventory")).toEqual([
      ["retry", 1],
      ["retry", 2],
    ])
    expect(view().kind).toBe("loading")

    await clock.advance(ACQUISITION_RETRY_DELAYS_MS[1])
    expect(operations(events, "inventory")).toEqual([
      ["retry", 1],
      ["retry", 2],
      ["success", 3],
    ])
    expect(view().kind).toBe("ready")
    expect(view().refreshFailed).toBe(false)
    expect(client.sessionCalls).toHaveLength(3)
    // The success reports the whole operation, retry waits included, while `attempt` stays 3.
    expect(events.filter((event) => event.operation === "inventory").at(-1)).toMatchObject({
      outcome: "success",
      attempt: 3,
      durationMs: retryWindowMs,
    })
    release()
  })

  test("exhausted retries log a final failure and report the owning operation", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    client.failListing = true
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, createStore(), clock, { log })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(view().kind).toBe("loading")

    await clock.advance(retryWindowMs)

    expect(operations(events, "inventory")).toEqual([
      ["retry", 1],
      ["retry", 2],
      ["failure", 3],
    ])
    expect(events.filter((event) => event.operation === "inventory").at(-1)).toMatchObject({
      sessionsRead: 0,
      messagesRead: 0,
      // The operation-wide duration covers both waits and all three attempts.
      durationMs: retryWindowMs,
    })
    expect(client.sessionCalls).toHaveLength(3)
    // Task 2 maps this internal error to the settled empty state, so it must stay observable here.
    expect(view().kind).toBe("error")
    expect(view().refreshFailed).toBe(true)
    release()
  })

  test("releasing the last consumer cancels a waiting retry without another attempt", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    client.failListing = true
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, createStore(), clock, { log })
    const release = service.hold()
    service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(client.sessionCalls).toHaveLength(1)

    release()
    await clock.settle()

    expect(operations(events, "inventory")).toEqual([
      ["retry", 1],
      ["cancelled", 1],
    ])
    await clock.advance(10 * retryWindowMs)
    expect(client.sessionCalls).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  test("a reset during a retry wait cancels the stale operation and rebuilds", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    client.listingFailures = 1
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, createStore(), clock, { log })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(operations(events, "inventory")).toEqual([["retry", 1]])

    const reset = service.reset()
    await clock.settle()
    await reset
    await clock.settle()

    expect(operations(events, "inventory")).toEqual([
      ["retry", 1],
      ["cancelled", 1],
      ["success", 1],
    ])
    // Only the failed attempt and the reset's own pass listed; the stale retry never restarted.
    expect(client.sessionCalls).toHaveLength(2)
    expect(view().kind).toBe("ready")
    expect(view().samples).toHaveLength(1)
    release()
  })

  test("releasing the last consumer during a drain cancels the pass instead of reporting success", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
      fixture("ses_c", NOW - 3_000, [measured(NOW - 3_500)]),
    ]
    const clock = createClock(NOW)
    const repository = createStore()
    const { events, log } = createLog()
    const service = createService(client, repository, clock, { log, concurrency: 2 })
    // Two workers of a multi-session pass are mid-scan when the last consumer goes away.
    const scan = createDeferred()
    client.scanDelay = () => scan.promise
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(client.inFlight).toBe(2)

    release()
    scan.resolve()
    await clock.settle()

    // Abandoned work is a cancellation, not a successful inventory of a partial cache.
    expect(operations(events, "inventory")).toEqual([["cancelled", 1]])
    expect(repository.readCoverage("/work/a")).toBeUndefined()
    expect(view().kind).not.toBe("ready")
    expect(clock.pending()).toBe(0)
  })

  test("a release landing as the retry wait fires does not restart acquisition", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    client.listingFailures = 1
    const clock = createClock(NOW)
    const { events, log } = createLog()
    let release = () => {}
    const service = createService(client, createStore(), clock, {
      log,
      // The wait resolves and the last consumer is released before the pass can resume.
      delay: (callback, ms) =>
        clock.delay(() => {
          callback()
          release()
        }, ms),
    })
    release = service.hold()
    service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(operations(events, "inventory")).toEqual([["retry", 1]])

    await clock.advance(ACQUISITION_RETRY_DELAYS_MS[0])

    expect(operations(events, "inventory")).toEqual([
      ["retry", 1],
      ["cancelled", 1],
    ])
    // The released pass never listed again and left no timer behind.
    expect(client.sessionCalls).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  test("a reset landing as the retry wait fires does not restart the stale pass", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    client.listingFailures = 1
    const clock = createClock(NOW)
    const { events, log } = createLog()
    let interfered = false
    const service = createService(client, createStore(), clock, {
      log,
      // The wait resolves and a reset takes over before the stale pass can resume.
      delay: (callback, ms) =>
        clock.delay(() => {
          callback()
          if (interfered || ms !== ACQUISITION_RETRY_DELAYS_MS[0]) return
          interfered = true
          void service.reset()
        }, ms),
    })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(operations(events, "inventory")).toEqual([["retry", 1]])

    await clock.advance(ACQUISITION_RETRY_DELAYS_MS[0])
    await clock.settle()

    expect(operations(events, "inventory")).toEqual([
      ["retry", 1],
      ["cancelled", 1],
      ["success", 1],
    ])
    // Only the failed attempt and the reset's own pass listed; the stale pass never resumed.
    expect(client.sessionCalls).toHaveLength(2)
    expect(view().kind).toBe("ready")
    release()
  })

  test("event-driven and audit scans log their own operations", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const events = createEventSource()
    const { events: logged, log } = createLog()
    const service = createService(client, createStore(), clock, { subscribeEvents: events.subscribe, log })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()

    events.emit("session.step.ended", "ses_a")
    await clock.advance(DIRTY_DEBOUNCE_MS)
    // One event scan reads the session metadata three times and its single message record once.
    expect(logged.filter((event) => event.operation === "event")).toEqual([
      { operation: "event", outcome: "success", durationMs: 0, attempt: 1, sessionsRead: 3, messagesRead: 1 },
    ])
    expect(view().kind).toBe("partial")

    await clock.advance(AUDIT_INTERVAL_MS)
    expect(operations(logged, "audit")).toEqual([["success", 1]])
    release()
  })

  test("a slow audit rotation is not restarted by the next tick", async () => {
    const client = new FakeClient()
    client.sessions = [
      fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)]),
      fixture("ses_b", NOW - 2_000, [measured(NOW - 2_500)]),
    ]
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, createStore(), clock, { log })
    const release = service.hold()
    service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    const scanned = client.messageCalls.length
    expect(scanned).toBe(2)

    // The rotation blocks on its first session across the following tick.
    const scan = createDeferred()
    client.scanDelay = () => scan.promise
    await clock.advance(AUDIT_INTERVAL_MS)
    expect(client.messageCalls).toHaveLength(scanned + 1)
    await clock.advance(AUDIT_INTERVAL_MS)
    expect(client.messageCalls).toHaveLength(scanned + 1)

    client.scanDelay = undefined
    scan.resolve()
    await clock.settle()
    // The rotation finishes both sessions exactly once.
    expect(operations(events, "audit")).toHaveLength(2)
    release()
  })

  test("a throwing logger never interrupts acquisition", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const repository = createStore()
    const service = createService(client, repository, clock, {
      log: () => {
        throw new Error("log sink unavailable")
      },
    })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()

    expect(view().kind).toBe("ready")
    expect(view().samples).toHaveLength(1)
    expect(storedRecords(repository)).toHaveLength(1)
    release()
  })

  test("a hydration failure is logged once, never retried, and never blocks acquisition", async () => {
    const base = createStore()
    const unreadable: HistoryRepository = {
      ...base,
      loadAllShards: () => {
        throw new Error("shards unreadable")
      },
    }
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, unreadable, clock, { log })
    const release = service.hold()

    const view = service.view({ directory: "/work/a", range: "all" })
    expect(view().samples).toHaveLength(0)
    await clock.settle()

    expect(events.filter((event) => event.operation === "hydrate")).toEqual([
      { operation: "hydrate", outcome: "failure", durationMs: 0, attempt: 1, sessionsRead: 0, messagesRead: 0 },
    ])
    expect(view().kind).toBe("ready")
    expect(view().samples).toHaveLength(1)
    release()
  })

  test("a persistence failure is logged separately and never retried", async () => {
    const failing: HistoryRepository = {
      ...createStore(),
      putRecords: async () => {
        throw new Error("disk full")
      },
    }
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, failing, clock, { log })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()

    const persistence = events.filter((event) => event.operation === "persistence")
    expect(persistence.length).toBeGreaterThan(0)
    for (const event of persistence) {
      expect(event).toMatchObject({
        outcome: "failure",
        attempt: 1,
        sessionsRead: 0,
        messagesRead: 0,
      })
    }
    expect(client.sessionCalls).toHaveLength(1)
    expect(view().kind).toBe("ready")
    expect(view().persistence).toBe("unavailable")
    release()
  })

  test("a confirmed 404 deletion probe stays normal inventory handling", async () => {
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
    expect(view().kind).toBe("ready")

    client.sessions = client.sessions.filter((entry) => entry.meta.id !== "ses_b")
    clock.setNow(NOW + INVENTORY_MIN_INTERVAL_MS + 1)
    service.refreshNow()
    await clock.settle()

    expect(operations(events, "inventory").at(-1)).toEqual(["success", 1])
    expect(events.filter((event) => event.outcome === "retry" || event.outcome === "failure")).toEqual([])
    expect(storedRecords(repository).map((record) => record.sessionID)).toEqual(["ses_a"])
    expect(repository.loadTombstones().sessionIDs).toEqual(["ses_b"])
    release()
  })

  test("a metadata read error inside a scan retries its owning operation instead of being swallowed", async () => {
    const client = new FakeClient()
    client.sessions = [fixture("ses_a", NOW - 1_000, [measured(NOW - 1_500)])]
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, createStore(), clock, { log })
    const release = service.hold()
    const view = service.view({ directory: "/work/a", range: "all" })
    await clock.settle()
    expect(view().kind).toBe("ready")
    events.length = 0

    // The session changed, and every metadata re-read now fails for a reason other than 404.
    client.getErrors.add("ses_a")
    client.sessions[0].meta = { ...client.sessions[0].meta, time: { created: NOW - 1_000, updated: NOW + 1_000 } }
    service.refreshNow()
    await clock.settle()
    await clock.advance(retryWindowMs)

    expect(operations(events, "catch-up")).toEqual([
      ["retry", 1],
      ["retry", 2],
      ["failure", 3],
    ])
    // The previously published measurements stay visible while the failure settles.
    expect(view().kind).toBe("error")
    expect(view().refreshFailed).toBe(true)
    expect(view().samples).toHaveLength(1)
    release()
  })

  test("a mid-pass failure settles its drain workers before the retry starts", async () => {
    const client = new FakeClient()
    client.sessions = ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e"].map((id, index) =>
      fixture(id, NOW - (index + 1) * 1_000, [measured(NOW - (index + 1) * 1_000 - 500)]),
    )
    client.scanErrors.add("ses_b")
    const clock = createClock(NOW)
    const { events, log } = createLog()
    const service = createService(client, createStore(), clock, { log, concurrency: 2 })
    const scan = createDeferred()
    client.scanDelay = () => scan.promise
    const release = service.hold()
    service.view({ directory: "/work/a", range: "all" })
    await clock.settle()

    // ses_b failed while the other worker is still scanning ses_a, so the attempt is not over yet.
    expect(client.inFlight).toBe(1)
    expect(operations(events, "inventory")).toEqual([])

    client.scanErrors.clear()
    scan.resolve()
    await clock.settle()
    expect(operations(events, "inventory")).toEqual([["retry", 1]])

    await clock.advance(ACQUISITION_RETRY_DELAYS_MS[0])

    expect(operations(events, "inventory")).toEqual([
      ["retry", 1],
      ["success", 2],
    ])
    // The retry never overlapped a worker left running by the failed attempt.
    expect(client.maxInFlight).toBeLessThanOrEqual(2)
    release()
  })
})
