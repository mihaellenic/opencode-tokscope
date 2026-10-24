import { describe, expect, test } from "bun:test"
import { allowedArtifactFile, bannedArtifactContent } from "../scripts/release-acceptance"

describe("allowedArtifactFile", () => {
  test("accepts exactly the five published artifact paths", () => {
    for (const path of [
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/tui.js",
      "package/dist/tui.js",
    ]) {
      expect(allowedArtifactFile(path)).toBe(true)
    }
  })

  test("rejects undeclared paths", () => {
    for (const path of [
      "package/docs/internal.md",
      "package/dist/tui.js.map",
      "package/dist/other.js",
      "package/.npmrc",
      "package/package.json.bak",
      "package/task-4-report.md",
      "package/dist/",
      "",
    ]) {
      expect(allowedArtifactFile(path)).toBe(false)
    }
  })
})

describe("bannedArtifactContent", () => {
  test("flags internal report markers", () => {
    expect(bannedArtifactContent("see task-4-report.md for details", "/Users/miha")).toBe(true)
    expect(bannedArtifactContent("tasks-4-report", "/Users/miha")).toBe(false)
  })

  test("flags PEM private key blocks", () => {
    for (const block of [
      "BEGIN PRIVATE KEY",
      "BEGIN RSA PRIVATE KEY",
      "BEGIN OPENSSH PRIVATE KEY",
      "-----BEGIN EC PRIVATE KEY-----",
    ]) {
      expect(bannedArtifactContent(block, "/Users/miha")).toBe(true)
    }
    expect(bannedArtifactContent("PRIVATE KEY handling is documented", "/Users/miha")).toBe(false)
  })

  test("flags the absolute source checkout path", () => {
    expect(bannedArtifactContent("/Users/miha/x/dist/tui.js content", "/Users/miha")).toBe(true)
    expect(bannedArtifactContent("normal js", "/Users/miha")).toBe(false)
  })

  test("does not flag an empty source root", () => {
    expect(bannedArtifactContent("normal js", "")).toBe(false)
  })

  test("accepts ordinary bundled output", () => {
    expect(bannedArtifactContent('import { x } from "@opentui/core"\nexport default x', "/Users/miha")).toBe(false)
  })
})
