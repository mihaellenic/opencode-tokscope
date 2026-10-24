import type { ReasoningFilter } from "./stats"

export type ScopeFilter = "project" | "all"
export type RangeFilter = "last7" | "last30" | "last90" | "all"

export interface Filters {
  scope: ScopeFilter
  range: RangeFilter
  reasoning: ReasoningFilter
}

export const DEFAULT_FILTERS: Filters = { scope: "all", range: "last30", reasoning: "all" }

const DAY_MS = 86_400_000

export function rangeStartMs(range: RangeFilter, nowMs: number): number | undefined {
  switch (range) {
    case "last7":
      return nowMs - 7 * DAY_MS
    case "last30":
      return nowMs - 30 * DAY_MS
    case "last90":
      return nowMs - 90 * DAY_MS
    case "all":
      return undefined
  }
}
