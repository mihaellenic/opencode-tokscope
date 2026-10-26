// Documentation-only terminal mockups. No OpenCode client, configuration, or history.
import { mkdir } from "node:fs/promises"
import { formatDayLabel, formatRate } from "../../src/format"
import type { Sample } from "../../src/metric"
import { axisLine, barChar, PLOT_ROWS } from "../../src/page/chart"
import { entryLines, headingLine } from "../../src/sidebar/layout"
import { widgetRows } from "../../src/sidebar/rank"
import { barLevels, comparisonRows, dailySeries } from "../../src/stats"

process.env.TZ = "UTC"
const now = Date.UTC(2026, 9, 25, 18)
const width = 150
const base = "#0a0a0a"
const muted = "#858585"
const foreground = "#eeeeee"
const accent = "#9bc5a5"
const models = [
  { providerID: "demo-cloud", modelID: "deepseek", name: "DeepSeek 4.1 Flash", rate: 142, calls: 2460 },
  { providerID: "demo-cloud", modelID: "glm-flash", name: "GLM 5.3 Flash", rate: 119, calls: 1380 },
  { providerID: "demo-cloud", modelID: "deepseek-pro", name: "DeepSeek V4 Pro", rate: 107, calls: 420 },
  { providerID: "demo-cloud", modelID: "glm", name: "GLM 5.3", rate: 90, calls: 290 },
  { providerID: "demo-local", modelID: "deepseek", name: "DeepSeek 4.1 Flash", rate: 73, calls: 690 },
  { providerID: "demo-cloud", modelID: "kimi", name: "Kimi K3", rate: 65, calls: 330 },
  { providerID: "demo-local", modelID: "nemotron", name: "Nemotron 3.5 Super", rate: 59, calls: 150 },
  { providerID: "demo-cloud", modelID: "minimax", name: "MiniMax M3.1 Flash", rate: 51, calls: 510 },
  { providerID: "demo-local", modelID: "glm", name: "GLM 5.3", rate: 44, calls: 270 },
  { providerID: "openai", modelID: "gpt", name: "GPT 6.1 Sol", rate: 36, calls: 1170 },
  { providerID: "openai", modelID: "gpt-luna", name: "GPT 6 Luna", rate: 29, calls: 810 },
  { providerID: "demo-local", modelID: "deepseek-pro", name: "DeepSeek V4 Pro", rate: 24, calls: 90 },
]
const providerName = (id: string) => id === "demo-cloud" ? "Ollama Cloud" : id === "openai" ? "OpenAI" : "OpenRouter"
const modelName = (providerID: string, modelID: string) =>
  models.find((model) => model.providerID === providerID && model.modelID === modelID)!.name
const samples: Sample[] = models.flatMap((model) => Array.from({ length: model.calls }, (_, call) => ({
  providerID: model.providerID, modelID: model.modelID, variant: "high",
  completedAt: model.modelID === "glm" && model.providerID === "demo-cloud"
    ? Date.UTC(2026, 8, 26 + (call % 30 < 13 ? call % 30 : call % 30 < 23 ? call % 30 + 1 : (call % 30) + 2), 4 + call % 14)
    : Date.UTC(2026, 8, 26 + call % 30, 12),
  rate: model.rate + (model.modelID === "glm" && model.providerID === "demo-cloud"
    ? ((call * 41) % 171 - 85) * 1.1
    : (call % 30 - 14) * 0.8) + ((call % 3) - 1) * 3,
})))
const rows = comparisonRows(samples, [])
const selected = rows.find((row) => row.providerID === "demo-cloud" && row.modelID === "glm")!
const series = dailySeries(samples, selected.key, Date.UTC(2026, 8, 25), now)
const levels = barLevels(series, PLOT_ROWS)
type Segment = { text: string; color?: string; bold?: boolean; background?: string }
type Line = Segment[]
const line = (text = "", color = muted, bold = false): Line => [{ text, color, bold }]
const pad = (text: string, size: number) => text.length <= size ? text.padEnd(size) : text.slice(0, size - 1) + "…"
// Column budgets mirror src/page/table.tsx at terminal width minus page padding.
const cells = (model: string, provider: string, rate: string, calls: string) =>
  [pad(model, 108), pad(provider, 18), pad(rate, 13), pad(calls, 5)].join("  ")
const overview: Line[] = [
  [{ text: "Tokscope", color: foreground, bold: true }, { text: " · all projects · last 30 days · reasoning: all settings" }],
  line(), line("  " + cells("Model", "Provider", "Median tok/s", "Calls")),
   ...rows.map((row) => line(`${row.key === selected.key ? "› " : "  "}${cells(
    modelName(row.providerID, row.modelID), providerName(row.providerID),
    row.median === null ? "unavailable" : formatRate(row.median), String(row.calls),
   )}`, row.key === selected.key ? foreground : muted, row.key === selected.key)),
  line(), line("Trend: GLM 5.3 · Ollama Cloud · last 30 days · all settings"), line(),
  ...Array.from({ length: PLOT_ROWS }, (_, index): Line => [
    ...levels.map((level, day) => ({
      text: barChar(level, PLOT_ROWS - 1 - index, PLOT_ROWS) + " ",
      color: day === series.length - 1 ? foreground : muted,
    })),
  ]),
  line(axisLine(series, series.length - 1)), line(),
  line(`${formatDayLabel(series.at(-1)!.date)} · ${series.at(-1)!.median!.toFixed(1)} tok/s · ${series.at(-1)!.calls} calls`, foreground, true),
]

const left = [
  line("Add retry handling to the demo API client", foreground, true),
  line("launchpad · synthetic session"), line(),
  line("Make transient failures retry safely, with a bounded backoff.", foreground), line(),
  line("Build", accent),
  line("Added bounded retries for transient responses and timeouts.", foreground),
  line("Non-retryable errors still fail immediately.", foreground), line(),
  line("  ✓ src/client.ts       retry policy and backoff"),
  line("  ✓ test/client.test.ts failure and recovery cases"), line(),
  line("$ bun test", accent), line("  18 pass · 0 fail"),
]
while (left.length < 26) left.push(line())
left.push(line("Ask a follow-up…"), line("Build · GLM 5.3 · Ollama Cloud", accent), line(), line())
const right = [
  line("launchpad", foreground, true), line("Retry handling"), line(),
  line("Context", foreground, true), line("12,840 tokens"), line("10% used"), line(),
  line("Modified Files", foreground, true), line("src/client.ts                 +28 -4"),
  line("test/client.test.ts           +42"),
]
while (right.length < 24) right.push(line())
right.push(
  [{ text: headingLine(41)[0].slice(0, 8), color: foreground, bold: true }, { text: headingLine(41)[0].slice(8) }],
  ...entryLines(widgetRows(samples, now).map((row) => ({
    model: modelName(row.providerID, row.modelID), provider: providerName(row.providerID), median: row.median,
  })), 41).map((text) => line(text)),
  line(), line(),
)
const sidebar = left.map((content, index): Line => [
  { text: "  " }, ...content,
  { text: " ".repeat(103 - content.reduce((sum, span) => sum + span.text.length, 0)) },
  { text: "  ", background: "#1b1f26" },
  ...right[index].map((span) => ({ ...span, background: "#1b1f26" })),
  { text: " ".repeat(43 - right[index].reduce((sum, span) => sum + span.text.length, 0)), background: "#1b1f26" },
])

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
function html(lines: Line[], title: string, caption: string, plain = false) {
  const lineHeight = plain ? 21 : 20
  // Browser font glyph metrics leave seams between terminal block characters.
  // Paint their exact cell coverage instead, preserving barChar's fractional tops.
  const renderText = (text: string) => {
    const level = "▁▂▃▄▅▆▇█".indexOf(text[0]) + 1
    return text.length === 2 && level > 0 && text[1] === " "
      ? `<b class="bar" style="height:${level / 8 * lineHeight}px"></b>`
      : escape(text)
  }
  const content = lines.map((spans) => `<div class="line">${spans.map((span) =>
    `<span style="width:${span.text.length * 9}px;color:${span.color ?? muted};background:${span.background ?? base};font-weight:${span.bold ? 700 : 400}">${renderText(span.text)}</span>`,
  ).join("")}</div>`).join("")
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>
  *{box-sizing:border-box}body{margin:0;width:${width * 9 + 64}px;padding:24px 32px;background:#222830;color:${foreground}}
  main{overflow:hidden;border:1px solid #39414d;border-radius:10px;background:${base};box-shadow:0 12px 28px #0004}
  header{height:42px;display:flex;align-items:center;padding:0 18px;gap:8px;background:#1e232b;border-bottom:1px solid #303744;color:#b5bdca;font:13px Menlo,monospace}
  i{width:9px;height:9px;border-radius:50%;background:#657080}header strong{margin-left:12px;font-weight:400}
  .terminal{padding:12px 0}.line{height:${lineHeight}px;white-space:pre;font:15px/${lineHeight}px Menlo,Consolas,monospace}.line span{display:inline-block;height:${lineHeight}px;vertical-align:top}
  .line span{position:relative}.bar{position:absolute;bottom:0;left:0;width:9px;background:currentColor}
  footer{padding-top:16px;font:12px/18px Menlo,Consolas,monospace;color:#bac2ce}
  ${plain ? `body{width:1406px;height:688px;padding:18px 10px 0;background:${base}}main{border:0;border-radius:0;box-shadow:none}header{display:none}.terminal{padding:0}footer{padding-top:22px;color:${muted};font-size:11px}` : ""}
  </style></head><body><main><header><i></i><i></i><i></i><strong>${escape(title)}</strong></header><section class="terminal">${content}</section></main><footer>${escape(caption)}</footer></body></html>`
}
const output = new URL("../../docs/images/", import.meta.url)
await mkdir(output, { recursive: true })
await Bun.write(new URL("tokscope-overview.html", output), html(overview, "OpenCode / Tokscope", "Illustrative mockup · Synthetic rates and provider assignments · Not a live capture or benchmark", true))
await Bun.write(new URL("tokscope-sidebar.html", output), html(sidebar, "OpenCode / launchpad", "Illustrative mockup · Synthetic data · Tokscope widget in a mocked host session; not a live capture"))
console.log("Generated overview (1406 × 688) and sidebar (1414 × 840) HTML mockups in docs/images/.")
