export function formatRate(median: number): string {
  return `${median.toFixed(1)} tok/s`
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "n/a"
  const units = ["", "k", "M", "B", "T", "P", "E"]
  let unit = 0
  // Judge the rounded value so 999,950 becomes 1.0M, not 1000.0k.
  while (unit < units.length - 1 && Math.abs(unit === 0 ? Math.round(n) : Math.round(n * 10) / 10) >= 1000) {
    n /= 1000
    unit++
  }
  return unit === 0 ? String(Math.round(n)) : `${n.toFixed(1)}${units[unit]}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "n/a"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

export function formatDayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number)
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    new Date(year, month - 1, day),
  )
}

export function modelDisplayName(
  models: readonly { id: string; providerID: string; name: string }[] | undefined,
  providerID: string,
  modelID: string,
): string {
  const match = models?.find((model) => model.id === modelID && model.providerID === providerID)
  return match?.name ?? `${providerID}/${modelID}`
}
