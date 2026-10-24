import type { SessionMessageInfo } from "@opencode/client"

export type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>

export interface Sample {
  providerID: string
  modelID: string
  variant: string | undefined
  rate: number
  completedAt: number
}

export interface UnavailableSample {
  providerID: string
  modelID: string
  variant: string | undefined
  completedAt: number
}

export type Classification =
  | { kind: "measured"; sample: Sample }
  | {
      kind: "unavailable"
      sample: UnavailableSample
      reason: "missing-streamed" | "missing-tokens" | "invalid-duration" | "no-generated-tokens"
    }
  | { kind: "excluded"; reason: "failed" | "in-progress" }

export function classifyAssistant(message: AssistantMessage): Classification {
  if (message.error !== undefined) return { kind: "excluded", reason: "failed" }

  const completedAt = message.time.completed
  if (completedAt === undefined) return { kind: "excluded", reason: "in-progress" }

  const attribution = {
    providerID: message.model.providerID,
    modelID: message.model.id,
    variant: message.model.variant,
    completedAt,
  }

  if (message.time.streamed === undefined) {
    return { kind: "unavailable", sample: attribution, reason: "missing-streamed" }
  }
  if (message.tokens === undefined) {
    return { kind: "unavailable", sample: attribution, reason: "missing-tokens" }
  }

  const durationMs = message.time.streamed - message.time.created
  if (durationMs <= 0) {
    return { kind: "unavailable", sample: attribution, reason: "invalid-duration" }
  }

  const generated = message.tokens.output + message.tokens.reasoning
  if (generated <= 0) {
    return { kind: "unavailable", sample: attribution, reason: "no-generated-tokens" }
  }

  return {
    kind: "measured",
    sample: {
      providerID: attribution.providerID,
      modelID: attribution.modelID,
      variant: attribution.variant,
      completedAt,
      rate: generated / (durationMs / 1000),
    },
  }
}
