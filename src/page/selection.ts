export { windowRange } from "../stats"

export function nextSelection(
  keys: readonly string[],
  current: string | undefined,
  delta: number,
): string | undefined {
  if (keys.length === 0) return undefined
  if (current === undefined) return keys[0]
  const index = keys.indexOf(current)
  if (index === -1) return keys[0]
  const next = Math.max(0, Math.min(index + delta, keys.length - 1))
  return keys[next]
}
