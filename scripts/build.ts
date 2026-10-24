import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "node",
  format: "esm",
  external: [
    "effect",
    "effect/*",
    "@opencode/plugin",
    "@opencode/plugin/*",
    "solid-js",
    "solid-js/*",
    "@opentui/core",
    "@opentui/core/*",
    "@opentui/solid",
    "@opentui/solid/*",
    "@opentui/keymap",
    "@opentui/keymap/*",
  ],
  plugins: [createSolidTransformPlugin()],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log(`built dist/tui.js (${result.outputs.length} outputs)`)
