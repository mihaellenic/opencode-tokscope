import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  createSpinnerTicker,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  type SpinnerClock,
} from "../src/spinner-ticker"

function fakeClock() {
  let tick: (() => void) | undefined
  let intervalMs: number | undefined
  const cleared: unknown[] = []

  const clock: SpinnerClock = {
    setInterval: (callback, ms) => {
      tick = callback
      intervalMs = ms
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: (id) => {
      cleared.push(id)
    },
  }

  return {
    clock,
    advance: () => tick?.(),
    intervalMs: () => intervalMs,
    cleared,
  }
}

describe("createSpinnerTicker", () => {
  test("advances one frame per interval and wraps around", () => {
    const fake = fakeClock()
    const { frame, dispose } = createRoot((dispose) => ({
      frame: createSpinnerTicker(fake.clock),
      dispose,
    }))

    expect(fake.intervalMs()).toBe(SPINNER_INTERVAL_MS)
    expect(frame()).toBe(SPINNER_FRAMES[0])

    for (const expected of SPINNER_FRAMES.slice(1)) {
      fake.advance()
      expect(frame()).toBe(expected)
    }

    fake.advance()
    expect(frame()).toBe(SPINNER_FRAMES[0])

    dispose()
  })

  test("stops its interval when the owning component is disposed", () => {
    const fake = fakeClock()
    const { dispose } = createRoot((dispose) => ({
      frame: createSpinnerTicker(fake.clock),
      dispose,
    }))

    expect(fake.cleared).toEqual([])

    dispose()

    expect(fake.cleared).toEqual([1])
  })
})
