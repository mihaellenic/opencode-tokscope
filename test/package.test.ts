import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

const manifest = JSON.parse(read("../package.json"))
const buildScript = read("../scripts/build.ts")
const rootEntrypoint = read("../tui.js").trim()

describe("package manifest", () => {
  test("publishes only the intended runtime roots", () => {
    expect(manifest.files).toEqual(["dist/", "tui.js"])
  })

  test("builds before packing without consumer build hooks", () => {
    expect(manifest.scripts.prepack).toBe("bun run build")
    for (const hook of ["preinstall", "install", "postinstall"]) {
      expect(manifest.scripts[hook]).toBeUndefined()
    }
  })

  test("preserves the TUI-only entrypoint", () => {
    expect(manifest.type).toBe("module")
    expect(manifest.exports).toEqual({ "./tui": "./dist/tui.js" })
    expect(rootEntrypoint).toBe('export { default } from "./dist/tui.js"')
  })

  test("declares host compatibility", () => {
    expect(manifest.dependencies["@opencode/plugin"]).toBe("2.1.2")
    expect(manifest.peerDependencies).toEqual({
      "@opentui/core": "^0.6.6",
      "@opentui/solid": "^0.6.6",
      "solid-js": "^1.9.12",
    })
  })

  test("pins the released baseline version", () => {
    expect(manifest.version).toBe("0.1.0")
    expect(manifest.version).toMatch(/^0\./)
  })

  test("points at the canonical repository", () => {
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/mihaellenic/opencode-tokscope.git",
    })
  })

  test("keeps host runtimes external", () => {
    for (const runtime of [
      "@opencode/plugin",
      "@opencode/plugin/*",
      "@opentui/core",
      "@opentui/solid",
      "solid-js",
    ]) {
      expect(buildScript).toContain(`"${runtime}"`)
    }
  })
})
