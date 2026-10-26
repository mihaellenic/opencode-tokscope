import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHistoryFileLogger, historyLogPath } from "../src/history/log-file"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "tokscope-log-test-"))
  roots.push(root)
  return root
}

const event = {
  operation: "catch-up" as const,
  outcome: "success" as const,
  durationMs: 75,
  attempt: 1,
  sessionsRead: 5,
  messagesRead: 200,
}

describe("history file logging", () => {
  test("respects XDG data home and has a home-directory fallback", () => {
    expect(historyLogPath({ XDG_DATA_HOME: "/data" }, "/home/test")).toBe("/data/opencode/log/tokscope.log")
    expect(historyLogPath({}, "/home/test")).toBe("/home/test/.local/share/opencode/log/tokscope.log")
  })

  test("writes ordered structured events and allowlists fields", async () => {
    const path = join(await scratch(), "log", "tokscope.log")
    const logger = createHistoryFileLogger(path)
    logger.log({ ...event, secret: "never log this", directory: "/private/project" } as typeof event)
    logger.log({ ...event, outcome: "failure" })
    await logger.flush()
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ event: "tokscope.history", ...event })
    expect(lines[0].timestamp).toEqual(expect.any(String))
    expect(lines[0].run).toBe(lines[1].run)
    expect(lines[1].outcome).toBe("failure")
    expect(JSON.stringify(lines)).not.toContain("never log this")
    expect(JSON.stringify(lines)).not.toContain("/private/project")
  })

  test("rotates a large log and keeps a fresh current file", async () => {
    const path = join(await scratch(), "tokscope.log")
    await writeFile(path, "x".repeat(1_048_576))
    const logger = createHistoryFileLogger(path)
    logger.log(event)
    await logger.flush()
    expect((await readFile(path + ".previous", "utf8")).length).toBe(1_048_576)
    expect(JSON.parse((await readFile(path, "utf8")).trim())).toMatchObject(event)
  })

  test("contains file-write failures without throwing or rejecting flush", async () => {
    const root = await scratch()
    const blocked = join(root, "not-a-directory")
    await writeFile(blocked, "file")
    const logger = createHistoryFileLogger(join(blocked, "tokscope.log"))
    expect(() => logger.log(event)).not.toThrow()
    await expect(logger.flush()).resolves.toBeUndefined()
  })
})
