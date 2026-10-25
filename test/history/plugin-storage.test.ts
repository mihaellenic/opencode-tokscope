import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createStore, produce } from "solid-js/store"
import { createRepository } from "../../src/history/durable"
import { createPluginDurableStore } from "../../src/history/plugin-storage"
import { CACHE_SCHEMA_VERSION, METRIC_VERSION, type SessionRecord } from "../../src/history/records"

/**
 * Fake of the host plugin storage: one live Solid store per key, `initial` on first use, updates
 * applied synchronously to a draft before the returned promise settles, and injectable failures.
 */
function createFakeStorage() {
  const durable = new Map<string, unknown>()
  const memory = new Map<string, unknown>()
  let failure: Error | undefined

  const storage: Plugin.Context["storage"] = {
    store<Value extends object>(key: string, options: { readonly initial: Value }) {
      const existing = durable.get(key)
      if (existing !== undefined) {
        return existing as readonly [Value, (mutation: (draft: Value) => void) => Promise<void>]
      }
      const [store, setStore] = createStore<Value>({ ...options.initial })
      const update = async (mutation: (draft: Value) => void): Promise<void> => {
        if (failure !== undefined) throw failure
        setStore(produce(mutation))
      }
      const pair = [store, update] as const
      durable.set(key, pair)
      return pair
    },
    memory<Value extends object>(key: string, options: { readonly initial: Value }) {
      const existing = memory.get(key)
      if (existing !== undefined) {
        return existing as readonly [Value, (mutation: (draft: Value) => void) => void]
      }
      const [store, setStore] = createStore<Value>({ ...options.initial })
      const pair = [store, (mutation: (draft: Value) => void) => setStore(produce(mutation))] as const
      memory.set(key, pair)
      return pair
    },
  }

  return {
    storage,
    keys: () => [...durable.keys()],
    fail(error: Error | undefined) {
      failure = error
    },
  }
}

const record: SessionRecord = {
  sessionID: "ses_1",
  directory: "/work/a",
  createdAt: 1_000,
  updatedAt: 2_000,
  fork: false,
  signature: "sig",
  scannedAtMs: 3_000,
  complete: true,
  samples: [{ providerID: "p", modelID: "m", variant: undefined, rate: 10, completedAt: 2_000 }],
  unavailable: [],
}

describe("createPluginDurableStore", () => {
  test("reads the initial empty object of an unused key", () => {
    const fake = createFakeStorage()
    expect(createPluginDurableStore(fake.storage).read("tks.tombstones")).toEqual({})
  })

  test("write then read round-trips and stays readable from a second adapter", async () => {
    const fake = createFakeStorage()
    const store = createPluginDurableStore(fake.storage)
    await store.write("tks.tombstones", (draft) => {
      draft.sessionIDs = ["ses_1"]
    })

    expect(store.read("tks.tombstones")).toEqual({ sessionIDs: ["ses_1"] })
    expect(createPluginDurableStore(fake.storage).read("tks.tombstones")).toEqual({ sessionIDs: ["ses_1"] })
  })

  test("a rejected store update propagates and keeps the previous value", async () => {
    const fake = createFakeStorage()
    const store = createPluginDurableStore(fake.storage)
    await store.write("tks.tombstones", (draft) => {
      draft.sessionIDs = ["ses_1"]
    })

    fake.fail(new Error("disk full"))
    await expect(
      store.write("tks.tombstones", (draft) => {
        draft.sessionIDs = []
      }),
    ).rejects.toThrow("disk full")
    expect(store.read("tks.tombstones")).toEqual({ sessionIDs: ["ses_1"] })
  })

  test("namespaces every durable key under history. with storage-safe segments", async () => {
    const fake = createFakeStorage()
    const repository = createRepository(createPluginDurableStore(fake.storage))
    await repository.putRecords([record], 4_000)
    await repository.removeSessions(["ses_1"], 4_000)

    const keys = fake.keys()
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key.startsWith("history.")).toBe(true)
      expect(key).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
    }
    expect(keys).toContain("history.tks.tombstones")
  })

  test("the repository reads sibling keys inside a mutation", async () => {
    const fake = createFakeStorage()
    const repository = createRepository(createPluginDurableStore(fake.storage))
    const snapshot = (range: "last7" | "last30") => ({
      schemaVersion: CACHE_SCHEMA_VERSION,
      metricVersion: METRIC_VERSION,
      directoryFilter: undefined,
      range,
      rows: [],
      lastCheckedAt: 5_000,
      savedAtMs: 5_000,
    })

    // The index update reads the snapshot slots written earlier while its own mutation runs.
    await repository.writeViewSnapshot(snapshot("last7"))
    await repository.writeViewSnapshot(snapshot("last30"))

    expect(repository.readViewSnapshot(undefined, "last7")?.range).toBe("last7")
    expect(repository.readViewSnapshot(undefined, "last30")?.range).toBe("last30")
    expect(fake.keys().filter((key) => key.startsWith("history.tks.snapshot.view.")).length).toBe(2)
  })
})
