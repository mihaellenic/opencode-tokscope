export interface WidgetEntry {
  model: string
  provider: string
  median: number
}

export const NO_QUALIFYING_MESSAGE = "No models with 3+ calls in 24h."

const UNIT = "tok/s"
const SEPARATOR = " · "

function unitLine(width: number): string {
  return " ".repeat(Math.max(0, width - UNIT.length)) + UNIT
}

export const HEADING_BRAND = "TokScope"
const HEADING_TITLE = `${HEADING_BRAND} · 24h`

export function headingLine(width: number): string[] {
  const gap = width - HEADING_TITLE.length - UNIT.length
  if (gap < 1) return [HEADING_TITLE, unitLine(width)]
  return [HEADING_TITLE + " ".repeat(gap) + UNIT]
}

function abbreviate(provider: string, budget: number): string {
  if (provider.length <= budget) return provider
  return provider.slice(0, budget - 1) + "…"
}

function alignSpeed(content: string, speed: string, width: number): string {
  const gap = Math.max(0, width - content.length - speed.length)
  return content + " ".repeat(gap) + speed
}

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ""

  for (const word of text.split(" ")) {
    const candidate = line === "" ? word : `${line} ${word}`
    if (candidate.length <= width) {
      line = candidate
      continue
    }

    if (line !== "") {
      lines.push(line)
      line = ""
    }

    let rest = word
    while (rest.length > width) {
      lines.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    line = rest
  }

  if (line !== "") lines.push(line)
  return lines
}

function wrapEntry(model: string, speed: string, width: number): string[] {
  const available = Math.max(1, width - speed.length - 2)
  const lines = wrapWords(model, available)
  const last = lines.pop() ?? ""
  return [...lines, alignSpeed(last, speed, width)]
}

export function entryLines(entries: readonly WidgetEntry[], width: number): string[] {
  const lines: string[] = []
  const usedLabels = new Map<string, boolean>()

  for (const entry of entries) {
    const speed = String(Math.round(entry.median))

    if (entry.model.length + speed.length + 2 > width) {
      lines.push(...wrapEntry(entry.model, speed, width))
      continue
    }

    let budget = width - entry.model.length - SEPARATOR.length - speed.length - 2
    if (budget < 2 || entry.provider.length === 0) {
      lines.push(alignSpeed(entry.model, speed, width))
      continue
    }

    let label = abbreviate(entry.provider, budget)
    let truncated = label !== entry.provider
    while (usedLabels.has(label) && (truncated || usedLabels.get(label) === true) && budget > 2) {
      budget--
      label = abbreviate(entry.provider, budget)
      truncated = true
    }
    usedLabels.set(label, truncated)

    lines.push(alignSpeed(entry.model + SEPARATOR + label, speed, width))
  }

  return lines
}
