export function formatRate(median: number): string {
  return `${median.toFixed(1)} tok/s`
}

export function formatDayLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number)
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    new Date(year, month - 1, day),
  )
}

export function formatCoverage(measured: number, unavailable: number): string {
  return unavailable > 0
    ? `${measured} measured calls; ${unavailable} unavailable`
    : `${measured} measured calls`
}

export function modelDisplayName(
  models: readonly { id: string; providerID: string; name: string }[] | undefined,
  providerID: string,
  modelID: string,
): string {
  const match = models?.find((model) => model.id === modelID && model.providerID === providerID)
  return match?.name ?? `${providerID}/${modelID}`
}
