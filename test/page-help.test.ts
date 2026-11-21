import { describe, expect, test } from "bun:test"
import { HELP_LINE } from "../src/page/help"

describe("page help line", () => {
  test("advertises the bound navigation keys; filter keys live in the header", () => {
    expect(HELP_LINE).toBe("↑↓ select · ←→ day · esc back · reset history in palette")
    expect(HELP_LINE).not.toMatch(/enter|reasoning|scope|range/)
  })
})
