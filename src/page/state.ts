import type { Sample, UnavailableSample } from "../metric"

export type PageState = "loading" | "error" | "empty" | "unmeasurable" | "ready"

export function pickPageState(
  result: { error: unknown } | undefined,
  samples: readonly Sample[],
  unavailable: readonly UnavailableSample[],
): PageState {
  if (result === undefined) return "loading"
  if (result.error !== undefined) return "error"
  if (samples.length > 0) return "ready"
  if (unavailable.length > 0) return "unmeasurable"
  return "empty"
}
