import type { DayPoint } from "../stats"
import { formatDayLabel } from "../format"

export const PLOT_ROWS = 8
const BAR_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

export function barChar(level: number | null, row: number, rows: number): string {
  if (level === null) return " "
  if (level > row + 1) return "█"
  if (level !== row + 1) return " "
  const index = Math.min(7, Math.max(0, Math.ceil((level / rows) * 8) - 1))
  return BAR_CHARS[index]
}

export function axisLine(visible: readonly DayPoint[], selected: number): string {
  if (visible.length === 0) return ""
  const width = visible.length * 2
  const chars = new Array<string>(width).fill(" ")
  const placed: [number, number][] = []
  const put = (label: string, at: number) => {
    const start = Math.max(0, Math.min(at, width - label.length))
    const end = start + label.length
    if (placed.some(([placedStart, placedEnd]) => start < placedEnd && placedStart < end)) return
    for (let index = 0; index < label.length && start + index < width; index++) chars[start + index] = label[index]
    placed.push([start, end])
  }
  const clamped = Math.max(0, Math.min(selected, visible.length - 1))
  const first = formatDayLabel(visible[0].date)
  const current = formatDayLabel(visible[clamped].date)
  const last = formatDayLabel(visible[visible.length - 1].date)
  put(current, clamped * 2 - Math.floor(current.length / 2))
  put(first, 0)
  put(last, width - last.length)
  return chars.join("").trimEnd()
}
