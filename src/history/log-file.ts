import { randomUUID } from "node:crypto"
import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { HistoryLogEvent } from "./service"

const MAX_LOG_BYTES = 1_048_576

export function historyLogPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "log", "tokscope.log")
}

/** Local diagnostics never write to stdout/stderr, which belong to the TUI renderer. */
export function createHistoryFileLogger(path = historyLogPath()): {
  log: (event: HistoryLogEvent) => void
  flush: () => Promise<void>
} {
  const run = randomUUID()
  let pending = Promise.resolve()

  return {
    log(event) {
      // Explicit fields prevent future additions (such as raw errors or paths) leaking into logs.
      const line = JSON.stringify({
        event: "tokscope.history",
        timestamp: new Date().toISOString(),
        run,
        operation: event.operation,
        outcome: event.outcome,
        durationMs: event.durationMs,
        attempt: event.attempt,
        sessionsRead: event.sessionsRead,
        messagesRead: event.messagesRead,
      }) + "\n"
      pending = pending.then(async () => {
        await mkdir(dirname(path), { recursive: true })
        const size = await stat(path).then((info) => info.size, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return 0
          throw error
        })
        if (size >= MAX_LOG_BYTES) await rename(path, path + ".previous")
        await appendFile(path, line, { encoding: "utf8", mode: 0o600 })
      }).catch(() => {
        // An unwritable diagnostic destination must not break refreshes or produce TUI output.
        // The next event retries the sink; no rejected promise escapes into plugin teardown.
      })
    },
    flush: () => pending,
  }
}
