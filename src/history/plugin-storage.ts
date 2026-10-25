import type { Plugin } from "@opencode/plugin/tui"
import { unwrap } from "solid-js/store"
import type { DurableStore } from "./durable"

/** The host's durable/ephemeral store factory; the named interface is not re-exported. */
type Storage = Plugin.Context["storage"]

/** Every tokscope segment is namespaced so the plugin never touches another plugin's keys. */
const KEY_PREFIX = "history."

/**
 * Durable adapter over the host plugin storage. `storage.store` is idempotent per key — it returns
 * the same live Solid store and update function on every call — so writes are per-key atomic
 * without a lock, and a mutation may still read other keys while it runs (the repository's index
 * merges depend on that).
 *
 * `read` returns the store's current value without the reactive proxy: the repository parses it
 * into fresh plain objects, so nothing mutates the store through a read and no reader subscribes
 * to another consumer's updates.
 */
export function createPluginDurableStore(storage: Storage): DurableStore {
  const entries = new Map<
    string,
    {
      read: () => Record<string, unknown>
      write: (mutation: (draft: Record<string, unknown>) => void) => Promise<void>
    }
  >()

  const entryOf = (key: string) => {
    const existing = entries.get(key)
    if (existing !== undefined) return existing
    const [store, update] = storage.store<Record<string, unknown>>(`${KEY_PREFIX}${key}`, {
      initial: {},
    })
    const entry = {
      read: () => unwrap(store),
      write: (mutation: (draft: Record<string, unknown>) => void) => update(mutation),
    }
    entries.set(key, entry)
    return entry
  }

  return {
    read(key) {
      return entryOf(key).read()
    },
    write(key, mutate) {
      return entryOf(key).write(mutate)
    },
  }
}
