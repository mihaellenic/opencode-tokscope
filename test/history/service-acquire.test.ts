import { describe, expect, test } from "bun:test"
import { rangeStartMs } from "../../src/filters"
import { collectMeasurements, type HarvestClient, type SessionMeta } from "../../src/harvest"
import { createMemoryStore, createRepository, type HistoryRepository } from "../../src/history/durable"
import { signatureFor, type SessionRecord } from "../../src/history/records"
import {
  createHistoryService,
  RECENT_CATCHUP_MS,
  type HistoryService,
  type ViewState,
} from "../../src/history/service"
import type { AssistantMessage } from "../../src/metric"
import { comparisonRows } from "../../src/stats"

const DAY_MS = 86_400_000
const NOW = 1_700_000_000_000

type SessionPage = { data: SessionMeta[]; cursor: { next?: string | null } }
type MessagePage = { data: AssistantMessage[]; cursor: { next?: string | null } }
type TokenUsage = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

const tokens = (output: number): TokenUsage => ({
  input: 0,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

type AssistantOverrides = {
  created?: number
  streamed?: number
  completed?: number
  variant?: string
  usage?: TokenUsage
}

function assistant(overrides: AssistantOverrides = {}): AssistantMessage {
  const { created = 1_000, streamed, completed, variant, usage } = overrides
  return {
    id: `msg_${created}_${completed ?? "open"}`,
    type: "assistant",
    agent: "build",
    model: { id: "m1", providerID: "p", ...(variant === undefined ? {} : { variant }) },
    content: [],
    time: {
      created,
      ...(streamed === undefined ? {} : { streamed }),
      ...(completed === undefined ? {} : { completed }),
    },
    ...(usage === undefined ? {} : { tokens: usage }),
  } as unknown as AssistantMessage
}

/** One measured request: `rate` output tokens per second over a one second stream. */
function measured(completedAt: number, rate = 10, variant?: string): AssistantMessage {
  return assistant({
    created: completedAt - 2_000,
    streamed: completedAt - 1_000,
    completed: completedAt,
    variant,
    usage: tokens(rate),
  })
}

/** A completed request with no token usage: counted, but not measurable. */
function unmeasured(completedAt: number, variant?: string): AssistantMessage {
  return assistant({ created: completedAt - 2_000, streamed: completedAt - 1_000, completed: completedAt, variant })
}

function meta(id: string, updatedAt: number, directory: string | undefined = "/work/a"): SessionMeta {
  return {
    id,
    time: { created: updatedAt - 60_000, updated: updatedAt },
    ...(directory === undefined ? {} : { location: { directory } }),
  }
}

interface SessionFixture {
  meta: SessionMeta
  messages: AssistantMessage[]
}

function fixture(
  id: string,
  updatedAt: number,
  messages: AssistantMessage[],
  directory = "/work/a",
): SessionFixture {
  return { meta: meta(id, updatedAt, directory), messages }
}

class FakeClient implements HarvestClient {
  sessions: SessionFixture[] = []
  sessionCalls: NonNullable<Parameters<HarvestClient["session"]["list"]>[0]>[] = []
  messageCalls: Parameters<HarvestClient["message"]["list"]>[0][] = []
  listingDelay: (() => Promise<void>) | undefined
  scanDelay: (() => Promise<void>) | undefined
  failListing = false
  inFlight = 0
  maxInFlight = 0

  private fixture(sessionID: string): SessionFixture | undefined {
    return this.sessions.find((entry) => entry.meta.id === sessionID)
  }

  session = {
    list: async (
      input?: NonNullable<Parameters<HarvestClient["session"]["list"]>[0]>,
    ): Promise<SessionPage> => {
      this.sessionCalls.push(input ?? {})
      if (this.failListing) throw new Error("listing failed")
      if (this.listingDelay !== undefined) await this.listingDelay()
      const directory = input?.directory
      const all = this.sessions
        .map((entry) => entry.meta)
        .filter((entry) => directory === undefined || entry.location?.directory === directory)
        .sort((left, right) => right.time.updated - left.time.updated || left.id.localeCompare(right.id))
      const offset = input?.cursor === undefined ? 0 : Number(input.cursor.slice(1))
      const limit = input?.limit ?? 100
      const nextOffset = offset + limit
      return {
        data: all.slice(offset, nextOffset),
        cursor: nextOffset < all.length ? { next: `c${nextOffset}` } : {},
      }
    },
    get: async (input: { sessionID: string }): Promise<SessionMeta> => {
      const entry = this.fixture(input.sessionID)
      if (entry === undefined) throw new Error(`not found: ${input.sessionID}`)
      return entry.meta
    },
  }

  message = {
    list: async (input: Parameters<HarvestClient["message"]["list"]>[0]): Promise<MessagePage> => {
      this.messageCalls.push(input)
      const entry = this.fixture(input.sessionID)
      if (entry === undefined) throw new Error(`unknown session: ${input.sessionID}`)
      this.inFlight++
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
      try {
        if (this.scanDelay !== undefined) await this.scanDelay()
        const offset = input.cursor === undefined ? 0 : Number(input.cursor.slice(1))
        const limit = input.limit ?? 200
        const nextOffset = offset + limit
        return {
          data: entry.messages.slice(offset, nextOffset),
          cursor: nextOffset < entry.messages.length ? { next: `c${nextOffset}` } : {},
        }
      } finally {
        this.inFlight--
      }
    },
  }
}

interface Scheduled {
  atMs: number
  seq: number
  run: () => void
  everyMs: number | undefined
  cancelled: boolean
  done: boolean
}

/** A virtual clock: `now`, one-shot `delay`, repeating `setTimer`, and scan waits share one queue. */
function createClock(startMs: number) {
  let nowMs = startMs
  let seq = 0
  const scheduled: Scheduled[] = []

  const schedule = (run: () => void, ms: number, everyMs?: number): (() => void) => {
    const entry: Scheduled = { atMs: nowMs + Math.max(0, ms), seq: seq++, run, everyMs, cancelled: false, done: false }
    scheduled.push(entry)
    return () => {
      entry.cancelled = true
    }
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  const nextDue = (target: number): Scheduled | undefined => {
    let best: Scheduled | undefined
    for (const entry of scheduled) {
      if (entry.cancelled || entry.done || entry.atMs > target) continue
      if (best === undefined || entry.atMs < best.atMs || (entry.atMs === best.atMs && entry.seq < best.seq)) {
        best = entry
      }
    }
    return best
  }

  const advance = async (ms: number): Promise<void> => {
    const target = nowMs + ms
    await settle()
    for (let guard = 0; guard < 100_000; guard++) {
      const due = nextDue(target)
      if (due === undefined) break
      nowMs = due.atMs
      if (due.everyMs === undefined) due.done = true
      else due.atMs += due.everyMs
      due.run()
      await settle()
    }
    nowMs = target
    await settle()
  }

  return {
    now: () => nowMs,
    setNow: (value: number) => {
      nowMs = value
    },
    delay: (run: () => void, ms: number) => schedule(run, ms),
    setTimer: (run: () => void, ms: number) => schedule(run, ms, ms),
    wait: (ms: number) => new Promise<void>((resolve) => schedule(() => resolve(), ms)),
    settle,
    advance,
  }
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createStore(): HistoryRepository {
  return createRepository(createMemoryStore())
}

function createService(
  client: HarvestClient,
  repository: HistoryRepository,
  clock: ReturnType<typeof createClock>,
  options: { concurrency?: number } = {},
): HistoryService {
  return createHistoryService({
    client,
    repository,
    subscribeEvents: () => () => {},
    setTimer: clock.setTimer,
    delay: clock.delay,
    now: clock.now,
    ...options,
  })
}

function storedRecords(repository: HistoryRepository): SessionRecord[] {
  return [...repository.loadAllShards().values()].flatMap((shard) => Object.values(shard.records))
}

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
