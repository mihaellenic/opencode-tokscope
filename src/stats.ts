import type { Sample, UnavailableSample } from "./metric"

export type ReasoningFilter = "all" | "unknown" | string

export interface ComparisonRow {
  key: string
  providerID: string
  modelID: string
  median: number | null
  calls: number
  unavailable: boolean
}

export interface DayPoint {
  date: string
  median: number | null
  calls: number
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

export function applyReasoningFilter(
  samples: Sample[],
  unavailable: UnavailableSample[],
  filter: ReasoningFilter,
): { samples: Sample[]; unavailable: UnavailableSample[] } {
  if (filter === "all") return { samples, unavailable }
  const matches = (variant: string | undefined) =>
    filter === "unknown" ? variant === undefined : variant === filter
  return {
    samples: samples.filter((sample) => matches(sample.variant)),
    unavailable: unavailable.filter((sample) => matches(sample.variant)),
  }
}

export function rowKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

export function comparisonRows(
  samples: Sample[],
  unavailable: UnavailableSample[],
): ComparisonRow[] {
  type Group = { providerID: string; modelID: string; rates: number[]; unavailable: number }
  const groups = new Map<string, Group>()
  const ensure = (providerID: string, modelID: string) => {
    const key = rowKey(providerID, modelID)
    let group = groups.get(key)
    if (group === undefined) {
      group = { providerID, modelID, rates: [], unavailable: 0 }
      groups.set(key, group)
    }
    return group
  }

  for (const sample of samples) ensure(sample.providerID, sample.modelID).rates.push(sample.rate)
  for (const sample of unavailable) ensure(sample.providerID, sample.modelID).unavailable++

  const rows = [...groups].map(([key, group]): ComparisonRow => {
    const measured = group.rates.length > 0
    return {
      key,
      providerID: group.providerID,
      modelID: group.modelID,
      median: measured ? median(group.rates) : null,
      calls: group.rates.length,
      unavailable: !measured && group.unavailable > 0,
    }
  })

  return rows.sort((a, b) => {
    const unavailableOrder = Number(a.unavailable) - Number(b.unavailable)
    if (unavailableOrder !== 0) return unavailableOrder
    const medianOrder = (b.median ?? Number.NEGATIVE_INFINITY) - (a.median ?? Number.NEGATIVE_INFINITY)
    if (medianOrder !== 0) return medianOrder
    if (b.calls !== a.calls) return b.calls - a.calls
    return a.key.localeCompare(b.key)
  })
}

function dayStart(epochMs: number): Date {
  const date = new Date(epochMs)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function localDayKey(epochMs: number): string {
  const date = new Date(epochMs)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

export function dailySeries(
  samples: Sample[],
  key: string,
  fromMs: number | undefined,
  nowMs: number,
): DayPoint[] {
  const matching = samples.filter((sample) => rowKey(sample.providerID, sample.modelID) === key)
  const startMs =
    fromMs ?? (matching.length > 0 ? Math.min(...matching.map((sample) => sample.completedAt)) : nowMs)

  const byDay = new Map<string, number[]>()
  for (const sample of matching) {
    const day = localDayKey(sample.completedAt)
    const rates = byDay.get(day)
    if (rates === undefined) byDay.set(day, [sample.rate])
    else rates.push(sample.rate)
  }

  const points: DayPoint[] = []
  const end = dayStart(nowMs)
  for (const cursor = dayStart(startMs); cursor.getTime() <= end.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    const date = localDayKey(cursor.getTime())
    const rates = byDay.get(date)
    points.push({
      date,
      median: rates === undefined ? null : median(rates),
      calls: rates?.length ?? 0,
    })
  }
  return points
}

export function windowRange(length: number, selected: number, size: number): { start: number; end: number } {
  const span = Math.max(0, Math.min(size, length))
  if (span === 0) return { start: 0, end: 0 }
  const clamped = Math.max(0, Math.min(selected, length - 1))
  const start = Math.max(0, Math.min(clamped - Math.floor(span / 2), length - span))
  return { start, end: start + span }
}

export function dayWindow(
  series: readonly DayPoint[],
  selected: number,
  width: number,
): { start: number; end: number } {
  return windowRange(series.length, selected, width)
}

export function barLevels(series: readonly DayPoint[], rows: number): (number | null)[] {
  const max = Math.max(0, ...series.map((point) => point.median ?? 0))
  return series.map((point) => {
    if (point.median === null || max <= 0) return null
    return Math.max(1, Math.round((point.median / max) * rows))
  })
}
