import { type HarvestClient, type SessionMeta } from "../../src/harvest"
import { createMemoryStore, createRepository, type HistoryRepository } from "../../src/history/durable"
import type { SessionRecord } from "../../src/history/records"
import { createHistoryService, type HistoryLogEvent, type HistoryService } from "../../src/history/service"
import type { AssistantMessage } from "../../src/metric"

export const DAY_MS = 86_400_000
export const NOW = 1_700_000_000_000

type SessionPage = { data: SessionMeta[]; cursor: { next?: string | null } }
type MessagePage = { data: AssistantMessage[]; cursor: { next?: string | null } }
type TokenUsage = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

export const tokens = (output: number): TokenUsage => ({
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
export function measured(completedAt: number, rate = 10, variant?: string): AssistantMessage {
  return assistant({
    created: completedAt - 2_000,
    streamed: completedAt - 1_000,
    completed: completedAt,
    variant,
    usage: tokens(rate),
  })
}

/** A completed request with no token usage: counted, but not measurable. */
export function unmeasured(completedAt: number, variant?: string): AssistantMessage {
  return assistant({ created: completedAt - 2_000, streamed: completedAt - 1_000, completed: completedAt, variant })
}

function meta(id: string, updatedAt: number, directory: string | undefined = "/work/a"): SessionMeta {
  return {
    id,
    time: { created: updatedAt - 60_000, updated: updatedAt },
    ...(directory === undefined ? {} : { location: { directory } }),
  }
}

export interface SessionFixture {
  meta: SessionMeta
  messages: AssistantMessage[]
}

export function fixture(
  id: string,
  updatedAt: number,
  messages: AssistantMessage[],
  directory = "/work/a",
): SessionFixture {
  return { meta: meta(id, updatedAt, directory), messages }
}

function notFound(sessionID: string): Error {
  // Shape of the installed client's `ClientError` for an unexpected 404 status.
  return Object.assign(new Error(`UnexpectedStatus: 404`), { status: 404, sessionID })
}

/** Paged fake of the session/message read API with injectable delays and failures. */
export class FakeClient implements HarvestClient {
  sessions: SessionFixture[] = []
  sessionCalls: NonNullable<Parameters<HarvestClient["session"]["list"]>[0]>[] = []
  messageCalls: Parameters<HarvestClient["message"]["list"]>[0][] = []
  /** Session ids whose metadata read fails for a reason other than not-found. */
  getErrors = new Set<string>()
  listingDelay: (() => Promise<void>) | undefined
  scanDelay: (() => Promise<void>) | undefined
  /** Called once per message page read, before the page resolves. */
  onScan: ((call: Parameters<HarvestClient["message"]["list"]>[0]) => void) | undefined
  failListing = false
  /** Remaining listing calls that throw before one succeeds, for deterministic retry sequences. */
  listingFailures = 0
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
      if (this.listingFailures > 0) {
        this.listingFailures -= 1
        throw new Error("listing failed")
      }
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
      if (this.getErrors.has(input.sessionID)) throw new Error("metadata unavailable")
      const entry = this.fixture(input.sessionID)
      if (entry === undefined) throw notFound(input.sessionID)
      return entry.meta
    },
  }

  message = {
    list: async (input: Parameters<HarvestClient["message"]["list"]>[0]): Promise<MessagePage> => {
      this.messageCalls.push(input)
      const entry = this.fixture(input.sessionID)
      if (entry === undefined) throw new Error(`unknown session: ${input.sessionID}`)
      this.onScan?.(input)
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

export interface Scheduled {
  atMs: number
  seq: number
  run: () => void
  everyMs: number | undefined
  cancelled: boolean
  done: boolean
}

/** A virtual clock: `now`, one-shot `delay`, repeating `setTimer`, and scan waits share one queue. */
export function createClock(startMs: number) {
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
    /** Timers that would still fire, i.e. neither cancelled nor already consumed. */
    pending: () => scheduled.filter((entry) => !entry.cancelled && !entry.done).length,
  }
}

export function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export function createStore(): HistoryRepository {
  return createRepository(createMemoryStore())
}

/** One event bus per service: tests emit session events through the single subscription. */
export function createEventSource() {
  const handlers: ((event: { type: string; data?: { sessionID?: string } }) => void)[] = []
  return {
    subscribe: (handler: (event: { type: string; data?: { sessionID?: string } }) => void): (() => void) => {
      handlers.push(handler)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    emit: (type: string, sessionID: string): void => {
      for (const handler of [...handlers]) handler({ type, data: { sessionID } })
    },
    subscribed: () => handlers.length,
  }
}

export function createService(
  client: HarvestClient,
  repository: HistoryRepository,
  clock: ReturnType<typeof createClock>,
  options: {
    concurrency?: number
    subscribeEvents?: (handler: (event: { type: string; data?: { sessionID?: string } }) => void) => () => void
    log?: (event: HistoryLogEvent) => void
  } = {},
): HistoryService {
  return createHistoryService({
    client,
    repository,
    subscribeEvents: options.subscribeEvents ?? (() => () => {}),
    setTimer: clock.setTimer,
    delay: clock.delay,
    now: clock.now,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.log === undefined ? {} : { log: options.log }),
  })
}

/** Collects service diagnostics for assertions without printing them. */
export function createLog(): { events: HistoryLogEvent[]; log: (event: HistoryLogEvent) => void } {
  const events: HistoryLogEvent[] = []
  return { events, log: (event) => events.push(event) }
}

export function storedRecords(repository: HistoryRepository): SessionRecord[] {
  return [...repository.loadAllShards().values()].flatMap((shard) => Object.values(shard.records))
}
