import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import type { AssistantMessage } from "../src/metric"
import { requestFact, TOKEN_CATEGORIES } from "../src/metric"

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

describe("requestFact", () => {
  test("keeps all five categories, recorded zero stays 0", () => {
    const fact = requestFact(assistant({ tokens: { input: 0, output: 5, reasoning: 0, cache: { read: 2, write: 0 } } }))

    expect(TOKEN_CATEGORIES).toEqual(["input", "output", "reasoning", "cacheRead", "cacheWrite"])
    expect(fact.tokens).toEqual({ input: 0, output: 5, reasoning: 0, cacheRead: 2, cacheWrite: 0 })
  })

  test("missing tokens omits the tokens key", () => {
    expect(requestFact(assistant())).not.toHaveProperty("tokens")
  })

  test("negative, NaN and string fields are omitted, valid siblings kept", () => {
    const fact = requestFact(assistant({
      tokens: { input: NaN, output: -1, reasoning: "3" as never, cache: { read: 4, write: Infinity } },
    }))

    expect(fact.tokens).toEqual({ cacheRead: 4 })
    expect(JSON.parse(JSON.stringify(fact.tokens))).toEqual(fact.tokens)
  })

  test("partial and wholly invalid tokens omit absent keys", () => {
    expect(requestFact(assistant({ tokens: { output: 5 } as never })).tokens).toEqual({ output: 5 })
    expect(requestFact(assistant({ tokens: { output: -1 } as never }))).not.toHaveProperty("tokens")
  })

  test("at is completed, else created", () => {
    expect(requestFact(assistant({ created: 1_000, completed: 3_000 })).at).toBe(3_000)
    expect(requestFact(assistant({ created: 1_000 })).at).toBe(1_000)
    expect(requestFact(assistant({ completed: 0 })).at).toBe(0)
  })

  test("duration eligible only when finished, not errored, streamed>created, completed>=streamed", () => {
    const happy = { created: 1_000, streamed: 2_000, completed: 3_000 }
    expect(requestFact(assistant(happy)).durationMs).toBe(1_000)
    expect(requestFact(assistant({ ...happy, completed: 2_000 })).durationMs).toBe(1_000)
    for (const overrides of [
      { error: { type: "provider" } },
      { completed: undefined },
      { streamed: undefined },
      { streamed: 1_000 },
      { streamed: 500 },
      { completed: 1_500 },
      { streamed: NaN },
      { created: NaN },
      { created: -Infinity },
      { streamed: Infinity },
      { completed: Infinity },
      { completed: NaN },
    ]) {
      expect(requestFact(assistant({ ...happy, ...overrides }))).not.toHaveProperty("durationMs")
    }
  })

  test("errored request with valid tokens still carries tokens", () => {
    const fact = requestFact(assistant({ tokens: tokens(10, 20, 30), error: { type: "provider" } }))
    expect(fact.tokens).toEqual({ input: 10, output: 20, reasoning: 30, cacheRead: 0, cacheWrite: 0 })
    expect(fact).not.toHaveProperty("durationMs")
  })

  test("abandoned step: completed, no streamed, no tokens", () => {
    const fact = requestFact(assistant({ completed: 3_000 }))
    expect(fact).not.toHaveProperty("durationMs")
    expect(fact).not.toHaveProperty("tokens")
  })

  test("fact contains no message text", () => {
    const message = assistant({
      streamed: 2_000, completed: 3_000, tokens: tokens(10, 20, 30),
      model: { providerID: "openai", id: "gpt-5", variant: "high" },
    })
    message.content = [{ type: "text", text: "SECRET-TEXT" }] as never
    const fact = requestFact(message)

    expect(fact).toMatchObject({ providerID: "openai", modelID: "gpt-5", variant: "high" })
    expect(JSON.stringify(fact)).not.toContain("SECRET-TEXT")
    expect(Object.keys(fact).every((key) => ["providerID", "modelID", "variant", "at", "tokens", "durationMs"].includes(key))).toBe(true)
  })
})

describe("classifyAssistant", () => {
  test("classifies a measured request", () => {
    const result = classifyFixture(
      assistant({
        created: 1_000,
        streamed: 11_000,
        completed: 12_000,
        tokens: tokens(100, 200, 50),
        model: { id: "claude-sonnet-4", providerID: "anthropic", variant: "high" },
      }),
    )

    expect(result.kind).toBe("measured")
    if (result.kind !== "measured") throw new Error("unreachable")
    expect(result.sample.rate).toBe(25)
    expect(result.sample.completedAt).toBe(12_000)
    expect(result.sample.providerID).toBe("anthropic")
    expect(result.sample.modelID).toBe("claude-sonnet-4")
    expect(result.sample.variant).toBe("high")
  })

  test("missing streamed time is unavailable, not zero", () => {
    const result = classifyFixture(
      assistant({ created: 1_000, completed: 12_000, tokens: tokens(100, 200, 50) }),
    )

    expect(result).toEqual({
      kind: "unavailable",
      reason: "missing-streamed",
      sample: expect.objectContaining({ providerID: "anthropic", modelID: "claude-sonnet-4" }),
    })
    if (result.kind !== "unavailable") throw new Error("unreachable")
    expect("rate" in result.sample).toBe(false)
  })

  test("zero duration is unavailable", () => {
    const result = classifyFixture(
      assistant({ created: 5_000, streamed: 5_000, completed: 6_000, tokens: tokens(100, 200, 50) }),
    )

    expect(result).toMatchObject({ kind: "unavailable", reason: "invalid-duration" })
  })

  test("zero generated tokens is unavailable", () => {
    const result = classifyFixture(
      assistant({ created: 1_000, streamed: 11_000, completed: 12_000, tokens: tokens(500, 0, 0) }),
    )

    expect(result).toMatchObject({ kind: "unavailable", reason: "no-generated-tokens" })
  })

  test("missing tokens is unavailable", () => {
    const result = classifyFixture(assistant({ created: 1_000, streamed: 11_000, completed: 12_000 }))

    expect(result).toMatchObject({ kind: "unavailable", reason: "missing-tokens" })
  })

  test("excludes failed requests entirely", () => {
    const result = classifyFixture(
      assistant({
        created: 1_000,
        streamed: 11_000,
        completed: 12_000,
        tokens: tokens(100, 200, 50),
        error: { type: "provider" },
      }),
    )

    expect(result).toEqual({ kind: "excluded", reason: "failed" })
  })

  test("excludes in-progress requests", () => {
    const result = classifyFixture(assistant({ created: 1_000, tokens: tokens(100, 200, 50) }))

    expect(result).toEqual({ kind: "excluded", reason: "in-progress" })
  })

  test("unavailable keeps model attribution", () => {
    const result = classifyFixture(
      assistant({
        created: 1_000,
        completed: 12_000,
        tokens: tokens(100, 200, 50),
        model: { id: "gpt-5", providerID: "openai", variant: "low" },
      }),
    )

    if (result.kind !== "unavailable") throw new Error("expected unavailable")
    expect(result.sample).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
      variant: "low",
      completedAt: 12_000,
    })
  })
})

function classifyFixture(message: AssistantMessage) {
  // Referenced lazily so the RED run fails on a missing module, not on syntax.
  const { classifyAssistant } = require("../src/metric") as typeof import("../src/metric")
  return classifyAssistant(message)
}
