import type { Sample } from "../metric"
import { median, rowKey } from "../stats"

export const WIDGET_WINDOW_MS = 24 * 60 * 60 * 1000
export const WIDGET_MIN_CALLS = 3
export const WIDGET_MAX_ENTRIES = 3

export interface WidgetRow {
  key: string
  providerID: string
  modelID: string
  median: number
  calls: number
}

export function widgetRows(samples: readonly Sample[], nowMs: number): WidgetRow[] {
  const since = nowMs - WIDGET_WINDOW_MS
  type Group = { providerID: string; modelID: string; rates: number[] }
  const groups = new Map<string, Group>()

  for (const sample of samples) {
    if (sample.completedAt <= since || sample.completedAt > nowMs) continue
    const key = rowKey(sample.providerID, sample.modelID)
    let group = groups.get(key)
    if (group === undefined) {
      group = { providerID: sample.providerID, modelID: sample.modelID, rates: [] }
      groups.set(key, group)
    }
    group.rates.push(sample.rate)
  }

  const rows: WidgetRow[] = []
  for (const [key, group] of groups) {
    if (group.rates.length < WIDGET_MIN_CALLS) continue
    const value = median(group.rates)
    if (value === null) continue
    rows.push({
      key,
      providerID: group.providerID,
      modelID: group.modelID,
      median: value,
      calls: group.rates.length,
    })
  }

  rows.sort((a, b) => {
    const medianOrder = b.median - a.median
    if (medianOrder !== 0) return medianOrder
    if (b.calls !== a.calls) return b.calls - a.calls
    return a.key.localeCompare(b.key)
  })

  return rows.slice(0, WIDGET_MAX_ENTRIES)
}
