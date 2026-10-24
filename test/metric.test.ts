import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import type { AssistantMessage } from "../src/metric"

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
