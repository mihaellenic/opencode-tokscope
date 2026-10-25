import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Sample, UnavailableSample } from "../src/metric"
import {
  collectMeasurements,
  collectVariants,
  inRangeSamples,
  listSessions,
  scanMessages,
  type HarvestClient,
} from "../src/harvest"
import { median } from "../src/stats"

type SessionFork = { sessionID: string; boundary: { type: "before" | "through"; messageID: string } }
type SessionStub = {
  id: string
  time: { created: number; updated: number }
  location?: { directory: string }
  fork?: SessionFork
}
type Page<T> = { data: T[]; cursor: { next?: string | null } }

function pages<T>(...groups: T[][]): Page<T>[] {
  return groups.map((data, index) => ({
    data,
    cursor: index < groups.length - 1 ? { next: `c${index + 1}` } : {},
  }))
}

function session(
  id: string,
  created: number,
  updated: number,
  directory?: string,
  fork?: SessionFork,
): SessionStub {
  return {
    id,
    time: { created, updated },
    ...(directory === undefined ? {} : { location: { directory } }),
    ...(fork === undefined ? {} : { fork }),
  }
}

type AssistantOverrides = {
  created?: number
  streamed?: number
  completed?: number
  model?: { id: string; providerID: string; variant?: string }
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  error?: unknown
}

function assistant(overrides: AssistantOverrides = {}): AssistantMessage {
  const { created = 1_000, streamed, completed, model, tokens, error } = overrides
  return {
    id: "msg_test",
    type: "assistant",
    agent: "build",
    model: model ?? { id: "claude-sonnet-4", providerID: "anthropic" },
    content: [],
    time: {
      created,
      ...(streamed === undefined ? {} : { streamed }),
      ...(completed === undefined ? {} : { completed }),
    },
    ...(tokens === undefined ? {} : { tokens }),
    ...(error === undefined ? {} : { error }),
  } as unknown as AssistantMessage
}

const tokens = (input: number, output: number, reasoning: number) => ({
  input,
  output,
  reasoning,
  cache: { read: 0, write: 0 },
})

const measured = (overrides: AssistantOverrides = {}) =>
  assistant({ created: 1_000, streamed: 2_000, completed: 2_500, tokens: tokens(100, 50, 50), ...overrides })

const sampleAt = (completedAt: number, variant?: string): Sample => ({
  providerID: "anthropic",
  modelID: "claude-sonnet-4",
  variant,
  rate: 10,
  completedAt,
})

const unavailableAt = (completedAt: number, variant?: string): UnavailableSample => ({
  providerID: "anthropic",
  modelID: "claude-sonnet-4",
  variant,
  completedAt,
})

class FakeClient implements HarvestClient {
  sessionCalls: NonNullable<Parameters<HarvestClient["session"]["list"]>[0]>[] = []
  messageCalls: Parameters<HarvestClient["message"]["list"]>[0][] = []
  inFlight = 0
  maxInFlight = 0
  rejectMessages = false

  constructor(
    private sessionPages: Page<SessionStub>[],
    private messagePages: Record<string, Page<AssistantMessage>[]> = {},
    private delayMs = 0,
  ) {}

  session = {
    list: async (input?: NonNullable<Parameters<HarvestClient["session"]["list"]>[0]>) => {
      this.sessionCalls.push(input ?? {})
      const index = input?.cursor ? Number(input.cursor.slice(1)) : 0
      return this.sessionPages[index]
    },
  }

  message = {
    list: async (input: Parameters<HarvestClient["message"]["list"]>[0]) => {
      this.messageCalls.push(input)
      if (this.rejectMessages) throw new Error("boom")
      this.inFlight++
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
      try {
        if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
        const pages = this.messagePages[input.sessionID] ?? [{ data: [], cursor: {} }]
        const index = input.cursor ? Number(input.cursor.slice(1)) : 0
        return pages[index]
      } finally {
        this.inFlight--
      }
    },
  }
}

describe("collectMeasurements", () => {
  test("paginates sessions newest-first with directory filter", async () => {
    const client = new FakeClient(pages([session("s1", 100, 200)], [session("s2", 50, 60)]))

    await collectMeasurements(client, { directory: "/tmp/project" })

    expect(client.sessionCalls).toHaveLength(2)
    expect(client.sessionCalls[0]).toMatchObject({ limit: 100, order: "desc", directory: "/tmp/project" })
    expect(client.sessionCalls[0].cursor).toBeUndefined()
    expect(client.sessionCalls[1].cursor).toBe("c1")
    expect(client.sessionCalls[1].order).toBeUndefined()
  })

  test("skips stale sessions", async () => {
    const client = new FakeClient(
      pages([session("stale", 0, 1_000), session("fresh", 500, 5_000)]),
      {
        stale: pages([measured()]),
        fresh: pages([measured()]),
      },
    )

    await collectMeasurements(client, { fromMs: 2_000 })

    expect(client.messageCalls.map((call) => call.sessionID)).toEqual(["fresh"])
  })

  test("fetches assistant messages per session with pagination", async () => {
    const client = new FakeClient(pages([session("s1", 0, 100)]), {
      s1: pages([measured(), measured()], [measured()]),
    })

    const result = await collectMeasurements(client, {})

    expect(client.messageCalls).toHaveLength(2)
    expect(client.messageCalls[0]).toMatchObject({
      sessionID: "s1",
      limit: 200,
      order: "desc",
      type: "assistant",
    })
    expect(client.messageCalls[1].cursor).toBe("c1")
    expect(client.messageCalls[1].order).toBeUndefined()
    expect(result.samples).toHaveLength(3)
  })

  test("splits measured and unavailable and collects variants", async () => {
    const client = new FakeClient(pages([session("s1", 0, 100)]), {
      s1: pages([
        measured({ model: { id: "claude-sonnet-4", providerID: "anthropic", variant: "high" } }),
        assistant({ created: 1_000, completed: 2_500, tokens: tokens(100, 50, 50) }),
        measured({ error: { type: "provider" } }),
      ]),
    })

    const result = await collectMeasurements(client, {})

    expect(result.samples).toHaveLength(1)
    expect(result.unavailable).toHaveLength(1)
    expect(result.unavailable[0].completedAt).toBe(2_500)
    expect(result.variants).toEqual(["high"])
  })

  test("filters messages by completion time", async () => {
    const client = new FakeClient(pages([session("s1", 0, 20_000)]), {
      s1: pages([
        measured({ completed: 5_000 }),
        measured({ completed: 12_000 }),
      ]),
    })

    const result = await collectMeasurements(client, { fromMs: 10_000 })

    expect(result.samples).toHaveLength(1)
    expect(result.samples[0].completedAt).toBe(12_000)
  })

  test("bounds concurrency", async () => {
    const sessions = ["s1", "s2", "s3", "s4", "s5"]
    const client = new FakeClient(
      pages(sessions.map((id) => session(id, 0, 100))),
      Object.fromEntries(sessions.map((id) => [id, pages([measured()])])),
      10,
    )
    const progress: number[] = []

    await collectMeasurements(client, { concurrency: 2, onProgress: (info) => progress.push(info.sessionsScanned) })

    expect(client.maxInFlight).toBeLessThanOrEqual(2)
    expect(progress.at(-1)).toBe(5)
  })

  test("keeps the project scope when session pages return other directories", async () => {
    const client = new FakeClient(
      pages([
        session("in-project", 0, 100, "/tmp/project"),
        session("elsewhere", 0, 100, "/tmp/other"),
      ]),
      {
        "in-project": pages([measured()]),
        elsewhere: pages([measured()]),
      },
    )

    const result = await collectMeasurements(client, { directory: "/tmp/project" })

    expect(client.messageCalls.map((call) => call.sessionID)).toEqual(["in-project"])
    expect(result.samples).toHaveLength(1)
  })

  test("propagates errors", async () => {
    const client = new FakeClient(pages([session("s1", 0, 100)]), { s1: pages([measured()]) })
    client.rejectMessages = true

    await expect(collectMeasurements(client, {})).rejects.toThrow("boom")
  })
})

describe("scanMessages", () => {
  test("returns complete session measurements without range filtering", async () => {
    const client = new FakeClient([], {
      s1: pages(
        [measured({ completed: 5_000 }), measured({ completed: 12_000 })],
        [measured({ completed: 30_000 })],
      ),
    })

    const result = await scanMessages(client, session("s1", 0, 40_000))

    expect(result.samples.map((sample) => sample.completedAt)).toEqual([5_000, 12_000, 30_000])
    expect(result.unavailable).toHaveLength(0)
    expect(client.messageCalls[0]).toMatchObject({
      sessionID: "s1",
      limit: 200,
      order: "desc",
      type: "assistant",
    })
    expect(client.messageCalls[1].cursor).toBe("c1")
    expect(client.messageCalls[1].order).toBeUndefined()
  })

  test("excludes inherited fork copies", async () => {
    const parentTen = {
      created: 0,
      streamed: 10_000,
      completed: 11_000,
      tokens: tokens(0, 100, 0),
    }
    const client = new FakeClient([], {
      s1: pages([
        measured(parentTen),
        measured({ created: 0, streamed: 1_000, completed: 2_000, tokens: tokens(0, 100, 0) }),
      ]),
      s2: pages([measured(parentTen)]),
    })

    const parent = await scanMessages(client, session("s1", 0, 20_000))
    const fork = await scanMessages(
      client,
      session("s2", 20_000, 30_000, undefined, {
        sessionID: "s1",
        boundary: { type: "through", messageID: "m1" },
      }),
    )
    const samples = [...parent.samples, ...fork.samples]

    expect(samples.map((sample) => sample.rate).sort((a, b) => a - b)).toEqual([10, 100])
    expect(median(samples.map((sample) => sample.rate))).toBe(55)
  })

  test("counts new requests created in the fork", async () => {
    const client = new FakeClient([], {
      s2: pages([
        measured({ created: 1_000, streamed: 2_000, completed: 2_500, tokens: tokens(50, 50, 0) }),
        measured({ created: 5_000, streamed: 6_000, completed: 7_000, tokens: tokens(25, 25, 0) }),
      ]),
    })

    const result = await scanMessages(
      client,
      session("s2", 5_000, 30_000, undefined, {
        sessionID: "s1",
        boundary: { type: "through", messageID: "m1" },
      }),
    )

    expect(result.samples).toHaveLength(1)
    expect(result.samples[0].completedAt).toBe(7_000)
  })

  test("counts independent identical requests in non-fork sessions", async () => {
    const identical = { created: 1_000, streamed: 2_000, completed: 2_500, tokens: tokens(50, 50, 0) }
    const client = new FakeClient([], { s1: pages([measured(identical), measured(identical)]) })

    const result = await scanMessages(client, session("s1", 0, 20_000))

    expect(result.samples).toHaveLength(2)
  })
})

describe("listSessions", () => {
  test("stops listing at the time boundary when a full page is stale", async () => {
    const client = new FakeClient(
      pages(
        [session("fresh", 0, 5_000)],
        [session("stale-1", 0, 1_000), session("stale-2", 0, 1_500)],
        [session("older", 0, 500)],
      ),
    )

    const result = await listSessions(client, { fromMs: 2_000 })

    expect(client.sessionCalls).toHaveLength(2)
    expect(client.messageCalls).toHaveLength(0)
    expect(result.sessions.map((entry) => entry.id)).toEqual(["fresh", "stale-1", "stale-2"])
    expect(result.boundaryReached).toBe(true)
  })

  test("continues past a mixed boundary page", async () => {
    const client = new FakeClient(
      pages(
        [session("fresh", 0, 5_000)],
        [session("mixed-fresh", 0, 3_000), session("mixed-stale", 0, 1_000)],
        [session("older", 0, 500)],
      ),
    )

    const result = await listSessions(client, { fromMs: 2_000 })

    expect(client.sessionCalls).toHaveLength(3)
    expect(result.boundaryReached).toBe(true)
  })

  test("reads every page for unbounded history", async () => {
    const client = new FakeClient(pages([session("s1", 0, 5_000)], [session("s2", 0, 1_000)]))

    const result = await listSessions(client, {})

    expect(client.sessionCalls).toHaveLength(2)
    expect(client.sessionCalls[0]).toMatchObject({ limit: 100, order: "desc" })
    expect(client.sessionCalls[1].cursor).toBe("c1")
    expect(client.sessionCalls[1].order).toBeUndefined()
    expect(result.sessions.map((entry) => entry.id)).toEqual(["s1", "s2"])
    expect(result.boundaryReached).toBe(true)
  })
})

describe("inRangeSamples", () => {
  test("filters both sample kinds below the range and leaves unbounded reads intact", () => {
    const result = {
      samples: [sampleAt(1_000), sampleAt(3_000, "high")],
      unavailable: [unavailableAt(500)],
    }

    const bounded = inRangeSamples(result, 2_000)

    expect(bounded.samples.map((sample) => sample.completedAt)).toEqual([3_000])
    expect(bounded.unavailable).toHaveLength(0)

    const unbounded = inRangeSamples(result, undefined)

    expect(unbounded.samples).toHaveLength(2)
    expect(unbounded.unavailable).toHaveLength(1)
  })
})

describe("collectVariants", () => {
  test("returns sorted unique variants across samples and unavailable", () => {
    const variants = collectVariants(
      [sampleAt(1_000, "high"), sampleAt(2_000), sampleAt(3_000, "low")],
      [unavailableAt(4_000, "high")],
    )

    expect(variants).toEqual(["high", "low"])
  })
})
