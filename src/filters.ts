export type ScopeFilter = "project" | "all"
export type RangeFilter = "today" | "last7" | "last30" | "last90" | "all"

export interface Filters {
  scope: ScopeFilter
  range: RangeFilter
}

export const DEFAULT_FILTERS: Filters = { scope: "all", range: "today" }

const DAY_MS = 86_400_000

/** "Today" is the local calendar day; the other ranges are rolling windows. */
export function rangeStartMs(range: RangeFilter, nowMs: number): number | undefined {
  switch (range) {
    case "today": {
      const now = new Date(nowMs)
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    }
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
