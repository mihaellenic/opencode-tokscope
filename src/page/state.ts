import type { Sample, UnavailableSample } from "../metric"

/** `loading` means an empty view still pending; every other state is settled content. */
export type PageState = "loading" | "empty" | "unmeasurable" | "ready"

/** The share of the history service's view state the page maps onto its own states. */
export interface PageView {
  kind: "loading" | "partial" | "cached" | "ready" | "error"
  samples: readonly Sample[]
  unavailable: readonly UnavailableSample[]
}

function contentState(view: PageView): Exclude<PageState, "loading"> {
  if (view.samples.length > 0) return "ready"
  if (view.unavailable.length > 0) return "unmeasurable"
  return "empty"
}

/**
 * Displayable rows outrank the publication kind, so progressive, cached, and failed refreshes never
 * replace or annotate visible results. Only an empty view that is still acquiring (including a cached
 * window awaiting revalidation) stays loading; a failed empty view settles to the normal empty state
 * instead of an error, because retries and diagnostics belong to the logs.
 */
export function pickViewPageState(view: PageView): PageState {
  const content = contentState(view)
  if (content !== "empty") return content
  return view.kind === "loading" || view.kind === "partial" || view.kind === "cached" ? "loading" : "empty"
}
