import { describe, expect, test } from "bun:test"
import { nextSelection, windowRange } from "../src/page/selection"

const keys = ["a", "b", "c", "d", "e"]

describe("nextSelection", () => {
  test("moves down and up", () => {
    expect(nextSelection(keys, "b", 1)).toBe("c")
    expect(nextSelection(keys, "b", -1)).toBe("a")
  })

  test("clamps at the ends", () => {
    expect(nextSelection(keys, "e", 1)).toBe("e")
    expect(nextSelection(keys, "a", -1)).toBe("a")
  })

  test("starts at the first row when nothing is selected", () => {
    expect(nextSelection(keys, undefined, 1)).toBe("a")
    expect(nextSelection(keys, undefined, -1)).toBe("a")
  })

  test("returns undefined for an empty list", () => {
    expect(nextSelection([], undefined, 1)).toBeUndefined()
  })
})

describe("windowRange", () => {
  test("keeps the selection visible", () => {
    const window = windowRange(10, 5, 4)
    expect(window.end - window.start).toBeLessThanOrEqual(4)
    expect(window.start).toBeLessThanOrEqual(5)
    expect(window.end).toBeGreaterThan(5)
  })

  test("clamps at the ends", () => {
    expect(windowRange(10, 0, 4)).toEqual({ start: 0, end: 4 })
    expect(windowRange(10, 9, 4)).toEqual({ start: 6, end: 10 })
  })
})
