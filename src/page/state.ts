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

/** The share of the history service's view state the page maps onto its own states. */
export interface PageView {
  kind: "loading" | "partial" | "cached" | "ready" | "error"
  samples: readonly Sample[]
  unavailable: readonly UnavailableSample[]
  persistence: "ok" | "unavailable"
  lastCheckedAt: number | undefined
}

/**
 * Progressive and cached publications are still results, so they use the ready content; a failed
 * refresh keeps its retained rows on screen and only becomes an error once nothing is left to show.
 */
export function pickViewPageState(view: PageView): PageState {
  if (view.kind === "loading") return "loading"
  const content = pickPageState({ error: undefined }, view.samples, view.unavailable)
  if (view.kind === "error" && content === "empty") return "error"
  return content
}
