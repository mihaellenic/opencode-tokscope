import { createSignal, onCleanup, type Accessor } from "solid-js"

/** One-cell braille frames, chosen for a steady sweep in common terminal fonts. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
export const SPINNER_INTERVAL_MS = 80

/** Injected timer surface so spinner timing is deterministic in tests. */
export interface SpinnerClock {
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>
  clearInterval(id: ReturnType<typeof setInterval>): void
}

const systemClock: SpinnerClock = { setInterval, clearInterval }

/**
 * Advances one spinner frame per tick for the lifetime of the owning computation. Cleanup clears the
 * interval, so a spinner unmounted because data arrived or loading settled leaves no timer behind.
 */
export function createSpinnerTicker(clock: SpinnerClock = systemClock): Accessor<string> {
  const [frame, setFrame] = createSignal<string>(SPINNER_FRAMES[0])
  let index = 0
  const timer = clock.setInterval(() => {
    index = (index + 1) % SPINNER_FRAMES.length
    setFrame(SPINNER_FRAMES[index])
  }, SPINNER_INTERVAL_MS)
  onCleanup(() => clock.clearInterval(timer))
  return frame
}
