import { describe, expect, test } from "bun:test"
import { HELP_LINE } from "../src/page/help"

describe("page help line", () => {
  test("advertises the bound navigation and filter keys without an unbound trend hint", () => {
    expect(HELP_LINE).toBe(
      "↑↓ select · ←→ day · s scope · t range · r reasoning · esc back · reset history in palette",
    )
    expect(HELP_LINE).not.toContain("enter")
  })
})
