/**
 * History cache benchmark: deterministic fixtures, five measured scenarios, one JSON line each.
 *
 * The fake client serves pages from memory with no network latency, so a timing here measures the
 * plugin's own CPU, store round-trips, and Solid publication cost — a lower bound on what a host
 * pays over the wire. Request counts are the machine-independent signal; timings are reported with
 * p50/p95 over `--repetitions` cold/warm/restart cycles.
 *
 *   mise exec bun@1.4.4 -- bun scripts/bench-history.ts
 *   mise exec bun@1.4.4 -- bun scripts/bench-history.ts --sessions 2500 --repetitions 5
 *   mise exec bun@1.4.4 -- bun scripts/bench-history.ts --smoke
 *
 * Fixture (binding): N ∈ {250, 2500, 10000} synthetic sessions, 100,000 measured samples split
 * proportionally (`100_000 / N` per session, so only the per-session density changes), message pages
 * of 200, one large active session of 5,000 samples at N=10000 whose neighbours absorb the
 * difference, and FNV-1a seeded ids so a rerun reproduces the exact same fixture.
 *
 * The report these numbers feed lives in the gitignored `docs/superpowers/reports/` directory; this
 * script is the only committed artifact.
 */
import { collectMeasurements, type HarvestClient, type SessionMeta } from "../src/harvest"
import { createMemoryStore, createRepository, fnv1a, type HistoryRepository } from "../src/history/durable"
import { createHistoryService, type HistoryService, type ViewState } from "../src/history/service"
import type { AssistantMessage } from "../src/metric"

const TOTAL_SAMPLES = 100_000
const LARGE_SESSION_SAMPLES = 5_000
const LARGE_SESSION_MIN_SESSIONS = 10_000
const MESSAGE_PAGE_SIZE = 200
const BENCH_SIZES = [250, 2_500, 10_000] as const
const DEFAULT_REPETITIONS = 5
const TIMEOUT_MS = 300_000

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/** Sessions are spread over 28 days; the newest sits a minute behind the anchor. */
const SESSION_SPREAD_MS = 28 * DAY_MS
const SESSION_AGE_MS = DAY_MS
/** The active session's samples all land inside the sidebar's 24 h window. */
const ACTIVE_SPREAD_MS = 6 * HOUR_MS
const NEWEST_OFFSET_MS = 60_000
const BENCH_DIRECTORY = "/bench/project"
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const USAGE = "usage: bun scripts/bench-history.ts [--sessions N] [--repetitions N] [--smoke]"

/**
 * Samples per synthetic session: `TOTAL_SAMPLES / sessions` each, so every size issues the same
 * request volume and only the per-session density changes. At the largest size one large active
 * session takes `LARGE_SESSION_SAMPLES` and the remaining sessions absorb the difference.
 */
function sampleCounts(sessions: number): number[] {
  if (!Number.isInteger(sessions) || sessions < 1) throw new Error(`invalid session count: ${sessions}`)
  const large = sessions >= LARGE_SESSION_MIN_SESSIONS ? 1 : 0
  const others = sessions - large
  const rest = TOTAL_SAMPLES - (large === 1 ? LARGE_SESSION_SAMPLES : 0)
  const base = Math.floor(rest / others)
  const remainder = rest - base * others
  const counts: number[] = []
  if (large === 1) counts.push(LARGE_SESSION_SAMPLES)
  for (let index = 0; index < others; index++) counts.push(base + (index < remainder ? 1 : 0))
  return counts
}

/** Seeded id in the durable key alphabet; FNV-1a mirrors the repository's `shardKey` scheme. */
function benchSessionID(index: number): string {
  const hash = fnv1a(`bench:${index}`).toString(16).padStart(8, "0")
  return `ses_${hash}_${index}`
}

const MODELS = [
  { providerID: "anthropic", modelID: "claude-bench" },
  { providerID: "openai", modelID: "gpt-bench" },
  { providerID: "google", modelID: "gemini-bench" },
] as const

type BenchModel = (typeof MODELS)[number]

interface BenchSession {
  meta: SessionMeta
  /** Newest first, one assistant message per measured sample. */
  messages: AssistantMessage[]
}

interface BenchFixture {
  counts: number[]
  sessions: BenchSession[]
  totalSamples: number
}

/** One completed assistant request: a one second stream whose generated tokens equal `rate`. */
function measuredMessage(input: {
  sessionID: string
  position: number
  completedAt: number
  model: BenchModel
  variant: string | undefined
  rate: number
}): AssistantMessage {
  return {
    id: `msg_${input.sessionID}_${input.position}`,
    type: "assistant",
    agent: "build",
    model: {
      id: input.model.modelID,
      providerID: input.model.providerID,
      ...(input.variant === undefined ? {} : { variant: input.variant }),
    },
    content: [],
    time: {
      created: input.completedAt - 2_000,
      streamed: input.completedAt - 1_000,
      completed: input.completedAt,
    },
    tokens: { input: 100, output: Math.max(1, Math.round(input.rate)), reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as AssistantMessage
}

function createFixture(sessions: number, anchorMs: number): BenchFixture {
  const counts = sampleCounts(sessions)
  const list: BenchSession[] = []
  let totalSamples = 0
  for (let index = 0; index < sessions; index++) {
    const count = counts[index]
    totalSamples += count
    const id = benchSessionID(index)
    const updated = anchorMs - NEWEST_OFFSET_MS - Math.floor((index * SESSION_SPREAD_MS) / sessions)
    // The active session is young enough that every one of its samples falls in the 24 h window.
    const created = updated - (index === 0 ? ACTIVE_SPREAD_MS : SESSION_AGE_MS)
    const span = updated - created
    let seed = fnv1a(id) | 1
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    const messages: AssistantMessage[] = []
    let output = 0
    let cost = 0
    for (let position = 0; position < count; position++) {
      const completedAt = updated - Math.round(((position + 1) * span) / (count + 1))
      const model = MODELS[next() % MODELS.length]
      const variant = position % 5 === 0 ? "high" : undefined
      const rate = 5 + (next() % 400) / 10
      output += Math.round(rate)
      cost += rate / 1_000_000
      messages.push(measuredMessage({ sessionID: id, position, completedAt, model, variant, rate }))
    }
    list.push({
      meta: {
        id,
        time: { created, updated },
        location: { directory: BENCH_DIRECTORY },
        cost,
        tokens: { input: count * 100, output, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      messages,
    })
  }
  return { counts, sessions: list, totalSamples }
}

function pagesFor(samples: number): number {
  return Math.ceil(samples / MESSAGE_PAGE_SIZE)
}

type SessionListInput = NonNullable<Parameters<HarvestClient["session"]["list"]>[0]>
type MessageListInput = Parameters<HarvestClient["message"]["list"]>[0]

/**
 * One event-loop turn per read. Without it every acquisition completes inside a single macrotask:
 * the publish throttle could never fire, no view would ever be observed as `partial`, and workers
 * would never overlap. `setImmediate` is a ~0.6 µs turn that still lets timers run, so the timings
 * stay dominated by the plugin's own work; it is a floor, not a simulated network latency.
 */
const awaitRead = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Paged in-memory fake of the session/message read API: newest first, 100/200 per page, one
 * event-loop turn per read. `session.list` deliberately ignores an age filter because the real API
 * takes a cursor, not `fromMs`; the bounded read stops on a stale page inside `listSessions`.
 */
class BenchClient implements HarvestClient {
  readonly sessions: BenchSession[]
  sessionListCalls = 0
  sessionGetCalls = 0
  messageListCalls = 0
  readonly messageCallsBySession = new Map<string, number>()
  maxInFlight = 0
  private readonly byID = new Map<string, BenchSession>()
  private ordered: SessionMeta[] | undefined
  private inFlight = 0

  constructor(sessions: BenchSession[]) {
    this.sessions = sessions
    for (const entry of sessions) this.byID.set(entry.meta.id, entry)
  }

  resetCounters(): void {
    this.sessionListCalls = 0
    this.sessionGetCalls = 0
    this.messageListCalls = 0
    this.messageCallsBySession.clear()
    this.maxInFlight = this.inFlight
  }

  /** A listing change that moves a session invalidates the newest-first order. */
  invalidateListing(): void {
    this.ordered = undefined
  }

  /** Newest first once per listing shape: the real API sorts server-side, not per page. */
  private listing(): SessionMeta[] {
    if (this.ordered === undefined) {
      this.ordered = this.sessions
        .map((entry) => entry.meta)
        .sort((left, right) => right.time.updated - left.time.updated || left.id.localeCompare(right.id))
    }
    return this.ordered
  }

  session = {
    list: async (input?: SessionListInput): Promise<{ data: SessionMeta[]; cursor: { next?: string | null } }> => {
      this.sessionListCalls += 1
      await awaitRead()
      const directory = input?.directory
      const all =
        directory === undefined
          ? this.listing()
          : this.listing().filter((meta) => meta.location?.directory === directory)
      const offset = input?.cursor === undefined ? 0 : Number(input.cursor.slice(1))
      const limit = input?.limit ?? 100
      const next = offset + limit
      return { data: all.slice(offset, next), cursor: next < all.length ? { next: `c${next}` } : {} }
    },
    get: async (input: { sessionID: string }): Promise<SessionMeta> => {
      this.sessionGetCalls += 1
      await awaitRead()
      const entry = this.byID.get(input.sessionID)
      // Shape of the installed client's `ClientError` for an unexpected 404 status.
      if (entry === undefined) throw Object.assign(new Error("UnexpectedStatus: 404"), { status: 404 })
      return entry.meta
    },
  }

  message = {
    list: async (input: MessageListInput): Promise<{ data: AssistantMessage[]; cursor: { next?: string | null } }> => {
      this.messageListCalls += 1
      this.messageCallsBySession.set(input.sessionID, (this.messageCallsBySession.get(input.sessionID) ?? 0) + 1)
      const entry = this.byID.get(input.sessionID)
      if (entry === undefined) throw new Error(`unknown session: ${input.sessionID}`)
      this.inFlight += 1
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
      try {
        await awaitRead()
        const offset = input.cursor === undefined ? 0 : Number(input.cursor.slice(1))
        const limit = input.limit ?? MESSAGE_PAGE_SIZE
        const next = offset + limit
        return {
          data: entry.messages.slice(offset, next),
          cursor: next < entry.messages.length ? { next: `c${next}` } : {},
        }
      } finally {
        this.inFlight -= 1
      }
    },
  }
}

/** Changes one session the way a completed step would: usage and timestamp move, messages do not. */
function markSessionChanged(client: BenchClient, sessionID: string, atMs: number): void {
  const entry = client.sessions.find((candidate) => candidate.meta.id === sessionID)
  if (entry === undefined) throw new Error(`unknown session: ${sessionID}`)
  const previous = entry.meta
  entry.meta = {
    ...previous,
    time: { ...previous.time, updated: atMs },
    cost: (previous.cost ?? 0) + 0.01,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  client.invalidateListing()
}

/** The service under bench runs on real timers: a script measures wall-clock behavior, not a clock. */
function createService(client: HarvestClient, repository: HistoryRepository): HistoryService {
  return createHistoryService({
    client,
    repository,
    subscribeEvents: () => () => {},
    setTimer: (callback, ms) => {
      const id = setInterval(callback, ms)
      return () => clearInterval(id)
    },
    delay: (callback, ms) => {
      const id = setTimeout(callback, ms)
      return () => clearTimeout(id)
    },
    now: () => Date.now(),
  })
}

const REQUEST = { directory: undefined, range: "last30" } as const

/** Yields a macrotask so the publish throttle and the store's promises can run between reads. */
const yieldToHost = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Waits until the wall clock is strictly past `value`, so a new publication is distinguishable. */
async function afterMs(value: number): Promise<number> {
  for (;;) {
    const current = Date.now()
    if (current > value) return current
    await yieldToHost()
  }
}

async function waitForReady(read: () => ViewState, floor: number, what: string): Promise<ViewState> {
  const deadline = performance.now() + TIMEOUT_MS
  for (;;) {
    const state = read()
    if (state.kind === "ready" && (state.lastCheckedAt ?? 0) >= floor) return state
    if (state.kind === "error") throw new Error(`${what}: the service reported an error state`)
    if (performance.now() > deadline) throw new Error(`${what}: timed out after ${TIMEOUT_MS} ms`)
    await yieldToHost()
  }
}

interface BaselineOpen {
  open: number
  ms: number
  sessionListCalls: number
  sessionGetCalls: number
  messageListCalls: number
  maxInFlight: number
  samples: number
}

interface ColdResult {
  msToPartial: number | null
  msToReady: number
  sessionListCalls: number
  sessionGetCalls: number
  messageListCalls: number
  maxInFlight: number
  samples: number
  scanned: number
}

interface WarmResult {
  ms: number
  sessionListCalls: number
  messageListCalls: number
  maxInFlight: number
  samples: number
  scanned: number
}

interface RestartResult {
  ms: number
  kind: ViewState["kind"]
  ok: boolean
  samples: number
  scanned: number
  widgetRows: number
}

interface DirtyResult {
  sessionID: string
  expectedPages: number
  ms: number
  messageListCalls: number
  sessionsCalled: string[]
  ok: boolean
}

interface CycleResult {
  cold: ColdResult
  warm: WarmResult
  restart: RestartResult
  dirty: DirtyResult
}

/** Two uncached default-view opens: the "before" numbers the cache has to beat. */
async function runBaseline(client: BenchClient): Promise<BaselineOpen[]> {
  const opens: BaselineOpen[] = []
  for (let open = 1; open <= 2; open++) {
    client.resetCounters()
    const started = performance.now()
    const fromMs = Date.now() - 30 * DAY_MS
    const result = await collectMeasurements(client, { fromMs })
    opens.push({
      open,
      ms: round(performance.now() - started),
      sessionListCalls: client.sessionListCalls,
      sessionGetCalls: client.sessionGetCalls,
      messageListCalls: client.messageListCalls,
      maxInFlight: client.maxInFlight,
      samples: result.samples.length,
    })
  }
  return opens
}

/** Cold open, warm reopen, restart from the persisted snapshot, then one dirty session. */
async function runCycle(sessions: number, anchorMs: number): Promise<CycleResult> {
  const fixture = createFixture(sessions, anchorMs)
  const client = new BenchClient(fixture.sessions)
  const store = createMemoryStore()
  const service = createService(client, createRepository(store))

  client.resetCounters()
  const coldStart = performance.now()
  const release = service.hold()
  try {
    const view = service.view(REQUEST)
    let msToPartial: number | null = null
    for (;;) {
      const state = view()
      if (msToPartial === null && state.kind === "partial") msToPartial = performance.now() - coldStart
      if (state.kind === "ready") break
      if (state.kind === "error") throw new Error("cold: the service reported an error state")
      if (performance.now() - coldStart > TIMEOUT_MS) throw new Error(`cold: timed out after ${TIMEOUT_MS} ms`)
      await yieldToHost()
    }
    const msToReady = performance.now() - coldStart
    const coldState = view()
    const cold: ColdResult = {
      msToPartial: msToPartial === null ? null : round(msToPartial),
      msToReady: round(msToReady),
      sessionListCalls: client.sessionListCalls,
      sessionGetCalls: client.sessionGetCalls,
      messageListCalls: client.messageListCalls,
      maxInFlight: client.maxInFlight,
      samples: coldState.samples.length,
      scanned: coldState.scanned,
    }

    const warmFloor = await afterMs(coldState.lastCheckedAt ?? 0)
    client.resetCounters()
    const warmStart = performance.now()
    service.refreshNow()
    const warmState = await waitForReady(view, warmFloor, "warm")
    const warm: WarmResult = {
      ms: round(performance.now() - warmStart),
      sessionListCalls: client.sessionListCalls,
      messageListCalls: client.messageListCalls,
      maxInFlight: client.maxInFlight,
      samples: warmState.samples.length,
      scanned: warmState.scanned,
    }

    const restartStart = performance.now()
    const restarted = createService(client, createRepository(store))
    const cached = restarted.view(REQUEST)()
    const restartMs = performance.now() - restartStart
    const restart: RestartResult = {
      ms: round(restartMs),
      kind: cached.kind,
      ok: cached.kind === "cached",
      samples: cached.samples.length,
      scanned: cached.scanned,
      widgetRows: restarted.widget()().rows.length,
    }

    const dirtyID = fixture.sessions[0].meta.id
    const expectedPages = pagesFor(fixture.counts[0])
    const dirtyFloor = await afterMs(warmState.lastCheckedAt ?? 0)
    markSessionChanged(client, dirtyID, Date.now())
    client.resetCounters()
    const dirtyStart = performance.now()
    service.refreshNow()
    await waitForReady(view, dirtyFloor, "dirty-one")
    const dirty: DirtyResult = {
      sessionID: dirtyID,
      expectedPages,
      ms: round(performance.now() - dirtyStart),
      messageListCalls: client.messageListCalls,
      sessionsCalled: [...client.messageCallsBySession.keys()],
      ok:
        client.messageListCalls === expectedPages &&
        client.messageCallsBySession.size === 1 &&
        client.messageCallsBySession.get(dirtyID) === expectedPages,
    }

    return { cold, warm, restart, dirty }
  } finally {
    release()
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

interface Summary {
  runs: number
  p50: number
  p95: number
  min: number
  max: number
  raw: number[]
}

/** Nearest-rank p50/p95; with five runs p95 is the slowest run, which the report states. */
function summarize(values: number[]): Summary {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    runs: sorted.length,
    p50: round(sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)]),
    p95: round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    raw: values.map(round),
  }
}

function countSummary(values: number[]): { median: number; raw: number[] } {
  const sorted = [...values].sort((left, right) => left - right)
  return { median: sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)], raw: values }
}

function print(line: object): void {
  console.log(JSON.stringify(line))
}

async function runSize(sessions: number, repetitions: number): Promise<void> {
  const anchorMs = Date.now()
  const baseline = await runBaseline(new BenchClient(createFixture(sessions, anchorMs).sessions))
  print({ scenario: "baseline", sessions, totalSamples: TOTAL_SAMPLES, opens: baseline })

  const cycles: CycleResult[] = []
  for (let repetition = 0; repetition < repetitions; repetition++) {
    cycles.push(await runCycle(sessions, anchorMs))
  }

  const colds = cycles.map((cycle) => cycle.cold)
  const warms = cycles.map((cycle) => cycle.warm)
  const restarts = cycles.map((cycle) => cycle.restart)
  const dirties = cycles.map((cycle) => cycle.dirty)
  const partials = colds.map((cold) => cold.msToPartial).filter((value): value is number => value !== null)
  const last = cycles[cycles.length - 1]

  print({
    scenario: "cold",
    sessions,
    runs: repetitions,
    msToPartial: partials.length === 0 ? null : summarize(partials),
    partialRuns: partials.length,
    msToReady: summarize(colds.map((cold) => cold.msToReady)),
    sessionListCalls: countSummary(colds.map((cold) => cold.sessionListCalls)),
    sessionGetCalls: countSummary(colds.map((cold) => cold.sessionGetCalls)),
    messageListCalls: countSummary(colds.map((cold) => cold.messageListCalls)),
    maxInFlight: {
      max: Math.max(...colds.map((cold) => cold.maxInFlight)),
      raw: colds.map((cold) => cold.maxInFlight),
    },
    samples: last.cold.samples,
    scanned: last.cold.scanned,
  })

  print({
    scenario: "warm",
    sessions,
    runs: repetitions,
    ms: summarize(warms.map((warm) => warm.ms)),
    sessionListCalls: countSummary(warms.map((warm) => warm.sessionListCalls)),
    messageListCalls: countSummary(warms.map((warm) => warm.messageListCalls)),
    maxInFlight: {
      max: Math.max(...warms.map((warm) => warm.maxInFlight)),
      raw: warms.map((warm) => warm.maxInFlight),
    },
    samples: last.warm.samples,
    scanned: last.warm.scanned,
  })

  print({
    scenario: "restart",
    sessions,
    runs: repetitions,
    ms: summarize(restarts.map((restart) => restart.ms)),
    kind: last.restart.kind,
    cached: restarts.every((restart) => restart.ok),
    samples: last.restart.samples,
    scanned: last.restart.scanned,
    widgetRows: last.restart.widgetRows,
  })

  print({
    scenario: "dirty-one",
    sessions,
    runs: repetitions,
    sessionID: last.dirty.sessionID,
    expectedPages: last.dirty.expectedPages,
    ms: summarize(dirties.map((dirty) => dirty.ms)),
    messageListCalls: countSummary(dirties.map((dirty) => dirty.messageListCalls)),
    sessionsCalled: [...new Set(dirties.flatMap((dirty) => dirty.sessionsCalled))],
    ok: dirties.every((dirty) => dirty.ok),
  })
}

/** Fixture invariants plus one N=250 cycle: the smoke run fails loudly instead of reporting. */
async function runSmoke(): Promise<boolean> {
  const failures: string[] = []
  const check = (condition: boolean, message: string): void => {
    if (!condition) failures.push(message)
  }

  for (const [sessions, expected] of [
    [250, 400],
    [2_500, 40],
    [10_000, 10],
  ] as const) {
    const counts = sampleCounts(sessions)
    check(counts.length === sessions, `sampleCounts(${sessions}): expected ${sessions} entries, got ${counts.length}`)
    const total = counts.reduce((sum, count) => sum + count, 0)
    check(total === TOTAL_SAMPLES, `sampleCounts(${sessions}): expected ${TOTAL_SAMPLES} samples, got ${total}`)
    if (sessions < LARGE_SESSION_MIN_SESSIONS) {
      check(
        counts.every((count) => count === expected),
        `sampleCounts(${sessions}): expected ${expected} samples per session`,
      )
    } else {
      check(
        counts[0] === LARGE_SESSION_SAMPLES,
        `sampleCounts(${sessions}): expected a ${LARGE_SESSION_SAMPLES} sample head`,
      )
      check(
        counts.slice(1).every((count) => count === 9 || count === 10),
        `sampleCounts(${sessions}): expected the neighbours to absorb the difference`,
      )
    }
  }

  const anchorMs = Date.now()
  const fixture = createFixture(250, anchorMs)
  const again = createFixture(250, anchorMs)
  const ids = fixture.sessions.map((entry) => entry.meta.id)
  check(new Set(ids).size === ids.length, "fixture: session ids must be unique")
  check(
    ids.every((id) => SESSION_ID_PATTERN.test(id)),
    "fixture: session ids must stay inside the durable key alphabet",
  )
  check(
    ids.every((id, index) => id === again.sessions[index].meta.id),
    "fixture: seeded ids must be deterministic across runs",
  )
  check(
    fixture.sessions.every(
      (entry, index) =>
        entry.messages.length === fixture.counts[index] &&
        entry.messages.length === again.sessions[index].messages.length,
    ),
    "fixture: every session must carry exactly its sample count of messages",
  )
  check(
    fixture.sessions.every((entry, index) =>
      entry.messages.every(
        (message, position) =>
          message.time.completed === again.sessions[index].messages[position].time.completed,
      ),
    ),
    "fixture: sample timestamps must be deterministic across runs",
  )
  check(
    fixture.totalSamples === TOTAL_SAMPLES,
    `fixture: expected ${TOTAL_SAMPLES} samples, got ${fixture.totalSamples}`,
  )
  check(pagesFor(400) === 2, "pages: 400 samples are two 200 message pages")
  check(pagesFor(10) === 1, "pages: 10 samples are one 200 message page")
  check(pagesFor(LARGE_SESSION_SAMPLES) === 25, "pages: 5,000 samples are 25 message pages")

  const baseline = await runBaseline(new BenchClient(createFixture(250, anchorMs).sessions))
  const cycle = await runCycle(250, anchorMs)

  check(cycle.cold.scanned === 250, `cold: expected 250 scanned sessions, got ${cycle.cold.scanned}`)
  check(
    cycle.cold.samples === TOTAL_SAMPLES,
    `cold: expected ${TOTAL_SAMPLES} view samples, got ${cycle.cold.samples}`,
  )
  check(cycle.cold.sessionListCalls === 3, `cold: expected 3 session pages, got ${cycle.cold.sessionListCalls}`)
  check(cycle.cold.messageListCalls === 500, `cold: expected 500 message pages, got ${cycle.cold.messageListCalls}`)
  check(cycle.cold.maxInFlight <= 8, `cold: expected at most 8 concurrent acquisitions, got ${cycle.cold.maxInFlight}`)
  check(cycle.warm.messageListCalls === 0, `warm: expected 0 message calls, got ${cycle.warm.messageListCalls}`)
  check(cycle.warm.samples === TOTAL_SAMPLES, `warm: expected the ready view to keep ${TOTAL_SAMPLES} samples`)
  check(cycle.restart.kind === "cached", `restart: expected a cached view, got ${cycle.restart.kind}`)
  check(cycle.restart.scanned === 250, `restart: expected 250 cached sessions, got ${cycle.restart.scanned}`)
  check(
    cycle.dirty.ok,
    `dirty-one: expected ${cycle.dirty.expectedPages} pages for one session, got ${cycle.dirty.messageListCalls}`,
  )

  print({
    scenario: "smoke",
    sessions: 250,
    baseline,
    cold: cycle.cold,
    warm: cycle.warm,
    restart: cycle.restart,
    dirty: cycle.dirty,
    failures,
    ok: failures.length === 0,
  })
  for (const failure of failures) console.error(`smoke: ${failure}`)
  return failures.length === 0
}

async function main(argv: string[]): Promise<number> {
  let sessions: number | undefined
  let repetitions = DEFAULT_REPETITIONS
  let smoke = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--smoke") {
      smoke = true
      continue
    }
    if (arg === "--sessions" || arg === "--repetitions") {
      const raw = argv[index + 1]
      const value = raw === undefined ? Number.NaN : Number(raw)
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} needs a positive integer\n${USAGE}`)
      if (arg === "--sessions") sessions = value
      else repetitions = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}\n${USAGE}`)
  }

  if (smoke) return (await runSmoke()) ? 0 : 1
  for (const size of sessions === undefined ? BENCH_SIZES : [sessions]) {
    await runSize(size, repetitions)
  }
  return 0
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  },
)
