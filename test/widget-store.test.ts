import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "../src/metric"
import type { HarvestClient } from "../src/harvest"
import {
  createWidgetStore,
  WIDGET_REFRESH_MS,
  type WidgetState,
  type WidgetStoreDeps,
} from "../src/sidebar/store"

const HOUR_MS = 60 * 60 * 1000
const NOW = 1_000_000_000_000

type Page<T> = { data: T[]; cursor: { next?: string | null } }
type SessionStub = { id: string; time: { created: number; updated: number } }

function measured(completed: number, rate: number): AssistantMessage {
  return {
    id: `msg_${completed}_${rate}`,
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: [],
    time: { created: completed - 2_000, streamed: completed - 1_000, completed },
    tokens: { input: 0, output: rate, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as AssistantMessage
}

class FakeClient implements HarvestClient {
  sessionCalls: NonNullable<Parameters<HarvestClient["session"]["list"]>[0]>[] = []
  reject = false
  delayMs = 0
  messages: AssistantMessage[] = []

  constructor(private sessions: SessionStub[] = [{ id: "s1", time: { created: 0, updated: NOW } }]) {}

  session = {
    list: async (input?: NonNullable<Parameters<HarvestClient["session"]["list"]>[0]>) => {
      this.sessionCalls.push(input ?? {})
      if (this.reject) throw new Error("read failed")
      return { data: this.sessions, cursor: {} }
    },
  }

  message = {
    list: async (input: Parameters<HarvestClient["message"]["list"]>[0]): Promise<Page<AssistantMessage>> => {
      if (this.reject) throw new Error("read failed")
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
      if (input.sessionID !== this.sessions[0]?.id) return { data: [], cursor: {} }
      return { data: this.messages, cursor: {} }
    },
  }
}

function fakeDeps(client: HarvestClient, now = () => NOW) {
  const handlers: (() => void)[] = []
  const timers: { callback: () => void; ms: number }[] = []
  let eventDetaches = 0
  let timerDetaches = 0
  const deps: WidgetStoreDeps = {
    client,
    onEvent: (handler) => {
      handlers.push(handler)
      return () => {
        eventDetaches++
      }
    },
    setTimer: (callback, ms) => {
      timers.push({ callback, ms })
      return () => {
        timerDetaches++
      }
    },
    now,
  }
  return {
    deps,
    handlers,
    timers,
    detaches: () => ({ eventDetaches, timerDetaches }),
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createWidgetStore", () => {
  test("loads into ready with ranked rows", async () => {
    const client = new FakeClient()
    client.messages = [
      measured(NOW - HOUR_MS, 40),
      measured(NOW - 2 * HOUR_MS, 40),
      measured(NOW - 3 * HOUR_MS, 40),
    ]
    const store = createWidgetStore(fakeDeps(client).deps)

    expect(store.state()).toEqual({ status: "loading", rows: [], stale: false })

    await store.refresh()

    expect(store.state()).toEqual({
      status: "ready",
      rows: [{ key: "p/m", providerID: "p", modelID: "m", median: 40, calls: 3 }],
      stale: false,
    })
    expect(client.sessionCalls).toHaveLength(1)
    expect(client.sessionCalls[0].directory).toBeUndefined()
  })

  test("applies the rolling 24h window end to end", async () => {
    const client = new FakeClient()
    client.messages = [
      measured(NOW - 25 * HOUR_MS, 10),
      measured(NOW - 26 * HOUR_MS, 20),
      measured(NOW - 27 * HOUR_MS, 30),
      measured(NOW - HOUR_MS, 50),
      measured(NOW - 2 * HOUR_MS, 50),
      measured(NOW - 3 * HOUR_MS, 50),
    ]
    const store = createWidgetStore(fakeDeps(client).deps)

    await store.refresh()

    expect(store.state().status).toBe("ready")
    expect(store.state().rows.map((row) => row.calls)).toEqual([3])
    expect(store.state().rows[0].median).toBe(50)
  })

  test("distinguishes a first failure from an empty ranking", async () => {
    const failing = new FakeClient()
    failing.reject = true
    const failedStore = createWidgetStore(fakeDeps(failing).deps)

    await failedStore.refresh()

    expect(failedStore.state()).toEqual({ status: "error", rows: [], stale: false })

    const empty = new FakeClient()
    empty.messages = [measured(NOW - HOUR_MS, 10), measured(NOW - 2 * HOUR_MS, 20)]
    const emptyStore = createWidgetStore(fakeDeps(empty).deps)

    await emptyStore.refresh()

    expect(emptyStore.state()).toEqual({ status: "ready", rows: [], stale: false })
  })

  test("marks retained rows stale on failure and recovers", async () => {
    const client = new FakeClient()
    client.messages = [
      measured(NOW - HOUR_MS, 10),
      measured(NOW - 2 * HOUR_MS, 20),
      measured(NOW - 3 * HOUR_MS, 30),
    ]
    const store = createWidgetStore(fakeDeps(client).deps)

    await store.refresh()
    const retained = store.state().rows
    expect(retained).toHaveLength(1)

    client.reject = true
    await store.refresh()

    expect(store.state()).toEqual<WidgetState>({ status: "ready", rows: retained, stale: true })

    client.reject = false
    client.messages = [...client.messages, measured(NOW - 4 * HOUR_MS, 100)]
    await store.refresh()

    expect(store.state().stale).toBe(false)
    expect(store.state().rows).toHaveLength(1)
    expect(store.state().rows[0].median).toBe(25)
  })

  test("coalesces overlapping refreshes", async () => {
    const client = new FakeClient()
    client.delayMs = 10
    client.messages = [
      measured(NOW - HOUR_MS, 40),
      measured(NOW - 2 * HOUR_MS, 40),
      measured(NOW - 3 * HOUR_MS, 40),
    ]
    const store = createWidgetStore(fakeDeps(client).deps)

    const first = store.refresh()
    const second = store.refresh()
    await Promise.all([first, second])

    expect(client.sessionCalls).toHaveLength(2)
    expect(store.state().status).toBe("ready")
  })

  test("attach wires event, timer, and initial load", async () => {
    const client = new FakeClient()
    client.messages = [
      measured(NOW - HOUR_MS, 40),
      measured(NOW - 2 * HOUR_MS, 40),
      measured(NOW - 3 * HOUR_MS, 40),
    ]
    const fake = fakeDeps(client)
    const store = createWidgetStore(fake.deps)

    const detach = store.attach()

    expect(fake.handlers).toHaveLength(1)
    expect(fake.timers).toHaveLength(1)
    expect(fake.timers[0].ms).toBe(WIDGET_REFRESH_MS)
    expect(client.sessionCalls).toHaveLength(1)

    await flush()
    expect(store.state().status).toBe("ready")

    fake.handlers[0]()
    await flush()
    expect(client.sessionCalls).toHaveLength(2)

    fake.timers[0].callback()
    await flush()
    expect(client.sessionCalls).toHaveLength(3)

    detach()
    expect(fake.detaches()).toEqual({ eventDetaches: 1, timerDetaches: 1 })
  })
})
