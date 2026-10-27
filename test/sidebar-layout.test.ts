import { describe, expect, test } from "bun:test"
import { entryLines, headingLine, NO_QUALIFYING_MESSAGE, type WidgetEntry } from "../src/sidebar/layout"

describe("headingLine", () => {
  test("reproduces the spec heading at 37 columns", () => {
    expect(headingLine(37)).toEqual(["TokScope · Today                tok/s"])
  })

  test("moves the unit to its own line at narrow widths", () => {
    expect(headingLine(19)).toEqual(["TokScope · Today", "              tok/s"])
  })
})

describe("entryLines", () => {
  const entries: WidgetEntry[] = [
    { model: "DeepSeek V4.1 Flash", provider: "Ollama Cloud", median: 133 },
    { model: "GLM 5.3", provider: "Ollama Cloud", median: 108 },
    { model: "DeepSeek V4 Pro 0813", provider: "Ollama Cloud", median: 102 },
  ]

  test("reproduces the spec illustration at 37 columns", () => {
    expect(entryLines(entries, 37)).toEqual([
      "DeepSeek V4.1 Flash · Ollama Cl…  133",
      "GLM 5.3 · Ollama Cloud            108",
      "DeepSeek V4 Pro 0813 · Ollama C…  102",
    ])
  })

  test("rounds speeds to integers", () => {
    const lines = entryLines(
      [
        { model: "Alpha", provider: "Provider", median: 133.7 },
        { model: "Beta", provider: "Provider", median: 102.4 },
      ],
      37,
    )

    expect(lines[0].endsWith("134")).toBe(true)
    expect(lines[1].endsWith("102")).toBe(true)
    expect(lines.some((line) => line.includes("."))).toBe(false)
  })

  test("omits the provider label when no usable space remains", () => {
    const model = "x".repeat(33)
    const lines = entryLines([{ model, provider: "Ollama Cloud", median: 7 }], 37)

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain(" · ")
    expect(lines[0].startsWith(model)).toBe(true)
    expect(lines[0]).toHaveLength(37)
    expect(lines[0].endsWith("7")).toBe(true)
  })

  test("distinguishes identical truncated labels", () => {
    const lines = entryLines(
      [
        { model: "ModelOneAA", provider: "Ollama Cloud", median: 100 },
        { model: "ModelTwoBB", provider: "Ollama Cloud", median: 100 },
      ],
      27,
    )

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(" · Ollama C…")
    expect(lines[1]).toContain(" · Ollama …")
    expect(lines[0].endsWith("100")).toBe(true)
    expect(lines[1].endsWith("100")).toBe(true)
    expect(lines[0]).not.toBe(lines[1])
  })

  test("wraps exceptionally long model names instead of truncating", () => {
    const model = "DeepSeek V4.1 Flash Ultra Long Model Name XX Tok"
    expect(model).toHaveLength(48)
    const lines = entryLines([{ model, provider: "Ollama Cloud", median: 7 }], 20)

    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20)
    expect(lines.some((line) => line.includes(" · "))).toBe(false)

    const last = lines[lines.length - 1]
    expect(last).toHaveLength(20)
    expect(last.endsWith("7")).toBe(true)

    const recovered = [...lines.slice(0, -1), last.slice(0, -1).trimEnd()]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    expect(recovered).toBe(model)
  })
})

describe("state messages", () => {
  test("the empty message stays compact", () => {
    expect(NO_QUALIFYING_MESSAGE.length).toBeLessThanOrEqual(37)
  })
})
