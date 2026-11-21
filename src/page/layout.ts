import { formatCompact, formatDuration } from "../format"
import type { ModelRow } from "../stats"

// OpenCode embeds Bun; globals also survive our node-targeted plugin build.
const stringWidth = Bun.stringWidth

export interface TableLayout {
  modelWidth: number
  barWidth: number
  showProvider: boolean
  showResponse: boolean
  showSpeed: boolean
}

export interface RowLabels {
  name: string
  provider: string
}

const PROVIDER_WIDTH = 14
const RESPONSE_WIDTH = 9
const SPEED_WIDTH = 8
const REQUEST_WIDTH = 8
const TOKEN_WIDTH = 6
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })
const columns = (width: number) => Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0

// Labels are terminal text, never control sequences or embedded newlines.
function plain(value: string): string {
  return Bun.stripANSI(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
}

function prefix(value: string, width: number): string {
  let result = ""
  let used = 0
  for (const { segment } of segmenter.segment(value)) {
    const size = stringWidth(segment)
    if (used + size > width) break
    result += segment
    used += size
  }
  return result
}

function cell(value: string, width: number): string {
  const text = plain(value)
  const clipped = stringWidth(text) <= width ? text : width > 0 ? prefix(text, width - 1) + "…" : ""
  return clipped + " ".repeat(Math.max(0, width - stringWidth(clipped)))
}

export function tableLayout(width: number): TableLayout {
  const available = columns(width)
  // 30 = marker + 12 model cells + Requests + Tokens + two single-cell gaps.
  const showSpeed = available >= 39
  const showResponse = available >= 49
  const showProvider = available >= 64
  const base = 30 + (showSpeed ? 9 : 0) + (showResponse ? 10 : 0) + (showProvider ? 15 : 0)
  // The extra cell separating the bar from Tokens is part of its budget.
  const barWidth = showProvider ? Math.min(8, Math.max(0, available - base - 1)) : 0
  const barBudget = barWidth > 0 ? barWidth + 1 : 0
  return {
    modelWidth: Math.max(0, Math.min(30, 12 + available - base - barBudget)),
    barWidth, showProvider, showResponse, showSpeed,
  }
}

export function tokenBar(value: number | null, max: number, width: number): string {
  if (value === null || !Number.isFinite(value) || !Number.isFinite(max) || value <= 0 || max <= 0) return ""
  const size = columns(width)
  return "█".repeat(Math.min(size, Math.max(1, Math.round(Math.min(1, value / max) * size))))
}

export function tableLines(
  rows: readonly ModelRow[],
  labels: (row: ModelRow) => RowLabels,
  selectedKey: string | undefined,
  width: number,
): { header: string; lines: string[] } {
  const available = columns(width)
  const layout = tableLayout(available)
  const max = rows.reduce((max, row) => Math.max(max, row.total ?? 0), 0)
  const line = (row?: ModelRow): string => {
    const label = row === undefined ? { name: "Model", provider: "Provider" } : labels(row)
    const cells = [cell(label.name, layout.modelWidth)]
    if (layout.showProvider) cells.push(cell(label.provider, PROVIDER_WIDTH))
    const requests = row === undefined ? (available < 40 ? "Req" : "Requests") : formatCompact(row.requests)
    const tokens = row === undefined ? (available < 40 ? "Tok" : "Tokens")
      : row.total === null ? "n/a" : formatCompact(row.total)
    cells.push(cell(requests, REQUEST_WIDTH))
    let tokenCell = cell(tokens, TOKEN_WIDTH)
    if (layout.barWidth > 0) {
      const bar = row === undefined ? "" : tokenBar(row.total, max, layout.barWidth)
      tokenCell += " " + cell(bar, layout.barWidth)
    }
    cells.push(tokenCell)
    if (layout.showResponse) {
      const response = row === undefined ? "Response" : row.responseMedian === null ? "n/a" : formatDuration(row.responseMedian)
      cells.push(cell(response, RESPONSE_WIDTH))
    }
    if (layout.showSpeed) {
      const speed = row === undefined ? "Speed" : row.throughput === null || !Number.isFinite(row.throughput) ? "n/a" : row.throughput.toFixed(1)
      cells.push(cell(speed, SPEED_WIDTH))
    }
    const marker = row !== undefined && row.key === selectedKey ? "› " : "  "
    return prefix(marker + cells.join(" "), available)
  }
  return { header: line(), lines: rows.map(row => line(row)) }
}

/** The indexed line equals `label + filled + empty`; JSX colors the parts without parsing user labels. */
export interface ReuseBar {
  lineIndex: number
  label: string
  filled: string
  empty: string
}

export interface DetailContent {
  lines: string[]
  reuseBar: ReuseBar | null
}

const REUSE_LABEL_WIDTH = "Cache reuse".length
const REUSE_BAR_WIDTH = 24
const REUSE_BAR_MIN_WIDTH = 4

// Rounding must not claim all or none of a mixed prompt came from cache.
function roundShare(share: number, scale: number): number {
  const rounded = Math.round(share * scale)
  return share > 0 && share < 1 ? Math.min(scale - 1, Math.max(1, rounded)) : rounded
}

// Wrap rather than truncate: selected identity and exact totals survive narrow terminals.
function wrap(value: string, width: number): string[] {
  if (width === 0) return []
  const lines: string[] = []
  let rest = plain(value)
  while (stringWidth(rest) > width) {
    let part = prefix(rest, width)
    if (part.length === 0) {
      // A terminal narrower than a single grapheme cannot display that grapheme.
      rest = rest.slice([...segmenter.segment(rest)][0].segment.length)
      continue
    }
    const space = part.lastIndexOf(" ")
    if (space > 0) part = part.slice(0, space)
    lines.push(part)
    rest = rest.slice(part.length).trimStart()
  }
  if (rest.length > 0) lines.push(rest)
  return lines
}

export function detailContent(row: ModelRow, labels: RowLabels, width: number): DetailContent {
  const available = columns(width)
  const lines: string[] = []
  const add = (text: string) => lines.push(...wrap(text, available))
  add(`${labels.name} · ${labels.provider} · ${formatCompact(row.requests)} requests`)
  const { input, output, reasoning, cacheRead, cacheWrite } = row.tokens
  // Prompt = everything sent to the model; input alone is only the fresh (uncached) part.
  const prompt = input === null || cacheRead === null || cacheWrite === null ? null : input + cacheRead + cacheWrite
  const generated = output === null || reasoning === null ? null : output + reasoning
  const reuse = prompt === null || cacheRead === null || prompt <= 0 ? null : cacheRead / prompt

  let reuseBar: ReuseBar | null = null
  if (reuse === null) add("Cache reuse n/a")
  else {
    const label = `Cache reuse ${roundShare(reuse, 100)}%  `
    const size = Math.min(REUSE_BAR_WIDTH, available - stringWidth(label))
    if (size < REUSE_BAR_MIN_WIDTH) add(label.trimEnd())
    else {
      const filledCells = roundShare(reuse, size)
      reuseBar = { lineIndex: lines.length, label, filled: "█".repeat(filledCells), empty: "░".repeat(size - filledCells) }
      lines.push(label + reuseBar.filled + reuseBar.empty)
    }
  }

  const numberWidth = Math.max(...[prompt, generated].map(value => value === null ? 3 : formatCompact(value).length))
  const total = (label: string, value: number | null, detail: string) =>
    add(`${label.padEnd(REUSE_LABEL_WIDTH)} ${(value === null ? "n/a" : formatCompact(value)).padStart(numberWidth)}${value === null ? "" : ` · ${detail}`}`)
  const part = (label: string, value: number | null) => `${label} ${value === null ? "n/a" : formatCompact(value)}`
  total("Prompt", prompt, [
    part("fresh", input), part("cached", cacheRead), ...(cacheWrite !== null && cacheWrite > 0 ? [part("written", cacheWrite)] : []),
  ].join(" + "))
  total("Generated", generated, `${part("output", output)} + ${part("reasoning", reasoning)}`)
  add(`Median response ${row.responseMedian === null ? "n/a" : formatDuration(row.responseMedian)} (p50)`)
  add(row.responseP95 === null ? "Most responses n/a (p95)" : `Most responses finished within ${formatDuration(row.responseP95)} (p95)`)
  return { lines, reuseBar }
}

export function detailLines(row: ModelRow, labels: RowLabels, width: number): string[] {
  return detailContent(row, labels, width).lines
}
