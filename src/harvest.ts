import { classifyAssistant, type AssistantMessage, type Sample, type UnavailableSample } from "./metric"
import type { SessionMessageInfo } from "@opencode/client"

export interface SessionMeta {
  id: string
  time: { created: number; updated: number }
  location?: { directory?: string }
  fork?: { sessionID: string; boundary: { type: "before" | "through"; messageID: string } }
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

export interface HarvestClient {
  session: {
    list(input?: {
      limit?: number
      order?: "asc" | "desc"
      directory?: string
      cursor?: string
    }): Promise<{
      data: SessionMeta[]
      cursor: { next?: string | null }
    }>
  }
  message: {
    list(input: {
      sessionID: string
      limit?: number
      order?: "asc" | "desc"
      type?: "assistant"
      cursor?: string
    }): Promise<{ data: SessionMessageInfo[]; cursor: { next?: string | null } }>
  }
}

export interface HarvestOptions {
  directory?: string
  fromMs?: number
  concurrency?: number
  onProgress?: (info: { sessionsScanned: number }) => void
}

export interface HarvestResult {
  samples: Sample[]
  unavailable: UnavailableSample[]
  variants: string[]
}

const SESSION_PAGE_SIZE = 100
const MESSAGE_PAGE_SIZE = 200
const DEFAULT_CONCURRENCY = 8

export async function listSessions(
  client: HarvestClient,
  options: { directory?: string; fromMs?: number },
): Promise<{ sessions: SessionMeta[]; boundaryReached: boolean }> {
  const sessions: SessionMeta[] = []
  const fromMs = options.fromMs
  let sessionCursor: string | undefined
  do {
    const page = await client.session.list(
      sessionCursor === undefined
        ? {
            limit: SESSION_PAGE_SIZE,
            order: "desc",
            ...(options.directory === undefined ? {} : { directory: options.directory }),
          }
        : { limit: SESSION_PAGE_SIZE, cursor: sessionCursor },
    )
    sessions.push(...page.data)
    // Pages are newest-first, so a page with nothing in range ends the bounded read.
    const stalePage =
      fromMs !== undefined && page.data.length > 0 && page.data.every((session) => session.time.updated < fromMs)
    if (stalePage) return { sessions, boundaryReached: true }
    sessionCursor = page.cursor.next ?? undefined
  } while (sessionCursor !== undefined)

  return { sessions, boundaryReached: true }
}

export function inRangeSamples(
  result: { samples: Sample[]; unavailable: UnavailableSample[] },
  fromMs: number | undefined,
): { samples: Sample[]; unavailable: UnavailableSample[] } {
  if (fromMs === undefined) return result
  return {
    samples: result.samples.filter((sample) => sample.completedAt >= fromMs),
    unavailable: result.unavailable.filter((sample) => sample.completedAt >= fromMs),
  }
}

export function collectVariants(samples: Sample[], unavailable: UnavailableSample[]): string[] {
  const variantSet = new Set<string>()
  for (const sample of samples) if (sample.variant !== undefined) variantSet.add(sample.variant)
  for (const sample of unavailable) if (sample.variant !== undefined) variantSet.add(sample.variant)
  return [...variantSet].sort()
}

export async function scanMessages(
  client: HarvestClient,
  session: SessionMeta,
): Promise<{ samples: Sample[]; unavailable: UnavailableSample[] }> {
  const samples: Sample[] = []
  const unavailable: UnavailableSample[] = []

  let messageCursor: string | undefined
  do {
    const page = await client.message.list(
      messageCursor === undefined
        ? { sessionID: session.id, limit: MESSAGE_PAGE_SIZE, order: "desc", type: "assistant" }
        : { sessionID: session.id, limit: MESSAGE_PAGE_SIZE, type: "assistant", cursor: messageCursor },
    )
    for (const message of page.data) {
      if (message.type !== "assistant") continue
      if (session.fork !== undefined && message.time.created < session.time.created) continue
      const result = classifyAssistant(message)
      if (result.kind === "measured") samples.push(result.sample)
      else if (result.kind === "unavailable") unavailable.push(result.sample)
    }
    messageCursor = page.cursor.next ?? undefined
  } while (messageCursor !== undefined)

  return { samples, unavailable }
}

export async function collectMeasurements(
  client: HarvestClient,
  options: HarvestOptions = {},
): Promise<HarvestResult> {
  const { sessions } = await listSessions(client, { directory: options.directory, fromMs: options.fromMs })

  const inRange = sessions.filter(
    (session) =>
      (options.fromMs === undefined || session.time.updated >= options.fromMs) &&
      (options.directory === undefined ||
        session.location?.directory === undefined ||
        session.location.directory === options.directory),
  )

  const samples: Sample[] = []
  const unavailable: UnavailableSample[] = []
  const inRangeAt = (completedAt: number) => options.fromMs === undefined || completedAt >= options.fromMs

  let scanned = 0
  let nextSession = 0
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, inRange.length))

  const worker = async () => {
    while (true) {
      const index = nextSession++
      if (index >= inRange.length) return
      const session = inRange[index]

      let messageCursor: string | undefined
      do {
        const page = await client.message.list(
          messageCursor === undefined
            ? { sessionID: session.id, limit: MESSAGE_PAGE_SIZE, order: "desc", type: "assistant" }
            : { sessionID: session.id, limit: MESSAGE_PAGE_SIZE, type: "assistant", cursor: messageCursor },
        )
        for (const message of page.data) {
          if (message.type !== "assistant") continue
          if (session.fork !== undefined && message.time.created < session.time.created) continue
          const result = classifyAssistant(message)
          if (result.kind === "measured" && inRangeAt(result.sample.completedAt)) samples.push(result.sample)
          else if (result.kind === "unavailable" && inRangeAt(result.sample.completedAt))
            unavailable.push(result.sample)
        }
        messageCursor = page.cursor.next ?? undefined
      } while (messageCursor !== undefined)

      scanned++
      options.onProgress?.({ sessionsScanned: scanned })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))

  return { samples, unavailable, variants: collectVariants(samples, unavailable) }
}
