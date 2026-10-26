/**
 * Release artifact acceptance for opencode-tokscope.
 *
 * Ports docs/releasing.md sections 1-4 into one gate that runs immediately
 * before `npm publish`:
 *   - export a clean tree with `git archive` (no dist/, no node_modules/)
 *   - prove the exported source installs, tests, and typechecks
 *   - pack exactly one tarball and validate its contents and manifest
 *   - prove host runtimes stay external and no internal/secret material leaks
 *   - install the tarball as a consumer and audit its production dependency tree
 *   - preserve the validated tarball and machine-readable metadata in --output-dir
 *
 * The script never publishes and never modifies the repository. Each run uses
 * a fresh scratch directory that is removed on every exit path, including
 * failures. The accepted tarball and audit evidence live only in the explicit
 * output directory. The parsing and validation helpers below are exported so
 * the tests can exercise them without running the orchestrator.
 *
 * `--verify-published <artifact.json>` verifies that the registry version and
 * dist.integrity match the metadata acceptance produced, with a bounded retry
 * for npm propagation.
 */
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  SEROVAL_AUDIT_EXCEPTION,
  auditExceptionDecision,
  auditExceptionEvidence,
  readConsumerVersions,
  type AuditExceptionDecision,
} from "./audit-exception"

/** The only paths the published tarball may contain (docs/releasing.md §3). */
export const ALLOWED_ARTIFACT_FILES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/tui.js",
  "package/dist/tui.js",
] as const

/** Host runtimes that the published bundle must keep external. */
export const REQUIRED_EXTERNAL_IMPORTS = [
  "@opencode/plugin/tui",
  "@opentui/core",
  "@opentui/solid",
  "solid-js",
] as const

const BANNED_CONTENT_PATTERNS: readonly RegExp[] = [
  /task-[0-9]+-report/, // internal task reports
  /BEGIN [A-Z ]*PRIVATE KEY/, // PEM private key blocks
]

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface ArtifactMetadata {
  name: string
  version: string
  filename: string
  path: string
  integrity: string
  shasum: string
  sha256: string
}

export type AcceptanceOptions =
  | { mode: "accept"; outputDir: string; allowPublished: boolean }
  | { mode: "verify"; metadataPath: string }

export type RegistryLookup =
  | { status: "unpublished" }
  | { status: "published"; version: string }
  | { status: "error"; code?: string; detail: string }

export type PublishedLookup =
  | { status: "published"; version: unknown; integrity: unknown }
  | { status: "error"; code?: string; detail: string }

export type AuditSeverity = "info" | "low" | "moderate" | "high" | "critical"

export interface AuditEntry {
  name: string
  severity: AuditSeverity
  advisories: string[]
}

export interface AuditSummary {
  entries: AuditEntry[]
  counts: Record<AuditSeverity, number>
  high: number
  critical: number
}

export interface VerificationOutcome {
  ok: boolean
  detail: string
  attempts: number
}

export function allowedArtifactFile(path: string): boolean {
  return (ALLOWED_ARTIFACT_FILES as readonly string[]).includes(path)
}

export function bannedArtifactContent(content: string, sourceRoot: string): boolean {
  if (BANNED_CONTENT_PATTERNS.some((pattern) => pattern.test(content))) return true
  return sourceRoot.length > 0 && content.includes(sourceRoot)
}

class AcceptanceFailure extends Error {
  readonly check: string

  constructor(check: string, message: string) {
    super(message)
    this.name = "AcceptanceFailure"
    this.check = check
  }
}

function exec(cmd: string[], cwd: string, env: Record<string, string | undefined> = process.env): CommandResult {
  const proc = Bun.spawnSync({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" })
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

function tail(text: string, lines = 20): string {
  const trimmed = text.trimEnd()
  if (!trimmed) return ""
  return trimmed.split("\n").slice(-lines).join("\n")
}

function describeFailure(label: string, result: CommandResult): string {
  const parts = [`${label} exited ${result.code}`]
  const stdout = tail(result.stdout)
  const stderr = tail(result.stderr)
  if (stdout) parts.push(`stdout (tail):\n${stdout}`)
  if (stderr) parts.push(`stderr (tail):\n${stderr}`)
  return parts.join("\n")
}

function requireOk(check: string, label: string, result: CommandResult): void {
  if (result.code !== 0) throw new AcceptanceFailure(check, describeFailure(label, result))
}

function require(condition: unknown, check: string, message: string): asserts condition {
  if (!condition) throw new AcceptanceFailure(check, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parse the first JSON object/array in command output that may have a log prefix. */
function parseJsonDocument(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new Error("command produced no JSON output")
  const start = trimmed.search(/[[{"]/)
  if (start === -1) throw new Error(`command output has no JSON:\n${tail(text)}`)
  return JSON.parse(trimmed.slice(start)) as unknown
}

/** Extract the JSON array from `npm pack --json`, tolerating prepack stdout. */
function parsePackOutput(stdout: string): Array<{ filename: string; integrity: string; shasum: string }> {
  const lines = stdout.split("\n")
  const start = lines.findIndex((line) => line.trimStart().startsWith("["))
  if (start === -1) throw new Error(`npm pack output has no JSON array:\n${tail(stdout)}`)
  const parsed: unknown = JSON.parse(lines.slice(start).join("\n"))
  if (!Array.isArray(parsed)) throw new Error("npm pack JSON is not an array")
  return parsed as Array<{ filename: string; integrity: string; shasum: string }>
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function walkFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) files.push(...walkFiles(full))
    else files.push(full)
  }
  return files
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/** npm pack reports SRI sha512; recompute it to prove the preserved bytes. */
export function sha512SriFile(path: string): string {
  const digest = createHash("sha512").update(readFileSync(path)).digest("base64")
  return `sha512-${digest}`
}

export { sha256File }

export function createArtifactMetadata(input: {
  name: string
  version: string
  filename: string
  path: string
  integrity: string
  shasum: string
  sha256: string
}): ArtifactMetadata {
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`artifact metadata field ${field} is missing`)
    }
  }
  const packagePart = input.name.replace(/^@/, "").replace(/\//g, "-")
  const expectedFilename = `${packagePart}-${input.version}.tgz`
  if (input.filename !== expectedFilename) {
    throw new Error(`artifact filename ${input.filename} does not match ${expectedFilename}`)
  }
  if (!input.integrity.startsWith("sha512-")) {
    throw new Error(`artifact integrity is not an npm sha512 SRI: ${input.integrity}`)
  }
  return { ...input }
}

export function validateArtifactMetadata(value: unknown): ArtifactMetadata {
  if (!isRecord(value)) throw new Error("artifact metadata is not an object")
  const fields = ["name", "version", "filename", "path", "integrity", "shasum", "sha256"]
  const input: Record<string, string> = {}
  for (const field of fields) {
    const item = value[field]
    if (typeof item !== "string") throw new Error(`artifact metadata field ${field} is missing`)
    input[field] = item
  }
  return createArtifactMetadata(input as Parameters<typeof createArtifactMetadata>[0])
}

/**
 * Copy the accepted tarball to the explicit output directory and write
 * artifact.json. The source bytes, the copied bytes, and npm's pack integrity
 * must all agree before any file is written.
 */
export function preserveArtifact(input: {
  source: string
  outputDir: string
  name: string
  version: string
  filename: string
  integrity: string
  shasum: string
}): ArtifactMetadata {
  const sourceIntegrity = sha512SriFile(input.source)
  if (sourceIntegrity !== input.integrity) {
    throw new Error(`tarball integrity ${sourceIntegrity} does not match npm pack integrity ${input.integrity}`)
  }
  const outputDir = resolve(input.outputDir)
  const metadata = createArtifactMetadata({
    name: input.name,
    version: input.version,
    filename: input.filename,
    path: join(outputDir, input.filename),
    integrity: input.integrity,
    shasum: input.shasum,
    sha256: sha256File(input.source),
  })
  mkdirSync(outputDir, { recursive: true })
  copyFileSync(input.source, metadata.path)
  const copiedIntegrity = sha512SriFile(metadata.path)
  if (copiedIntegrity !== input.integrity) {
    throw new Error(`preserved tarball integrity ${copiedIntegrity} does not match accepted ${input.integrity}`)
  }
  writeFileSync(join(outputDir, "artifact.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

function jsonError(text: string): { code?: string; detail: string } {
  try {
    const parsed = parseJsonDocument(text)
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const code = typeof parsed.error.code === "string" ? parsed.error.code : undefined
      const summary = typeof parsed.error.summary === "string" ? parsed.error.summary : undefined
      const detail = typeof parsed.error.detail === "string" ? parsed.error.detail : undefined
      return { code, detail: [summary, detail].filter(Boolean).join(": ") || tail(text, 5) }
    }
  } catch {
    // Fall through to the raw output tail.
  }
  return { detail: tail(text, 5) }
}

/** Distinguish "version not published" (E404) from registry/auth outages. */
export function classifyRegistryLookup(result: CommandResult): RegistryLookup {
  if (result.code === 0) {
    try {
      const parsed = parseJsonDocument(result.stdout)
      if (typeof parsed === "string" && parsed.length > 0) {
        return { status: "published", version: parsed }
      }
      if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed[0].length > 0) {
        return { status: "published", version: parsed[0] }
      }
      return { status: "error", detail: "npm view succeeded without a version" }
    } catch (error) {
      return {
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }
  const info = jsonError(result.stdout)
  const fallback = info.detail ? info : jsonError(result.stderr)
  if (fallback.code === "E404") return { status: "unpublished" }
  return { status: "error", code: fallback.code, detail: fallback.detail || tail(result.stderr, 5) }
}

export function registryGuardDecision(
  lookup: RegistryLookup,
  options: { allowPublished: boolean },
): { ok: true; detail: string; warning?: string } | { ok: false; detail: string } {
  if (lookup.status === "unpublished") return { ok: true, detail: "version is not published" }
  if (lookup.status === "error") {
    const code = lookup.code ? ` (${lookup.code})` : ""
    return { ok: false, detail: `registry lookup failed${code}; refusing to guess whether the version is available: ${lookup.detail}` }
  }
  if (!options.allowPublished) {
    return {
      ok: false,
      detail: `version ${lookup.version} is already published; published versions are immutable. Use --allow-published only for explicit local validation.`,
    }
  }
  return {
    ok: true,
    detail: "already published (explicit --allow-published local bypass)",
    warning: `version ${lookup.version} is already published; continuing because --allow-published was passed`,
  }
}

export function parseAcceptanceArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): AcceptanceOptions {
  let outputDir: string | undefined
  let verifyPublished: string | undefined
  let allowPublished = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--output-dir") {
      const value = argv[index + 1]
      if (!value) throw new Error("--output-dir requires a directory")
      outputDir = value
      index += 1
    } else if (argument?.startsWith("--output-dir=")) {
      outputDir = argument.slice("--output-dir=".length)
    } else if (argument === "--verify-published") {
      const value = argv[index + 1]
      if (!value) throw new Error("--verify-published requires an artifact.json path")
      verifyPublished = value
      index += 1
    } else if (argument?.startsWith("--verify-published=")) {
      verifyPublished = argument.slice("--verify-published=".length)
    } else if (argument === "--allow-published") {
      allowPublished = true
    } else {
      throw new Error(`unknown argument: ${argument ?? "<empty>"}`)
    }
  }

  if (allowPublished && (env.CI === "true" || env.GITHUB_ACTIONS === "true")) {
    throw new Error("--allow-published is for explicit local validation only; CI must always fail on duplicate versions")
  }
  if (verifyPublished) {
    if (outputDir) throw new Error("--verify-published cannot be combined with --output-dir")
    if (allowPublished) throw new Error("--verify-published cannot be combined with --allow-published")
    return { mode: "verify", metadataPath: verifyPublished }
  }
  if (!outputDir) {
    throw new Error("--output-dir is required so the accepted tarball and audit evidence are preserved")
  }
  return { mode: "accept", outputDir, allowPublished }
}

const AUDIT_SEVERITIES: readonly AuditSeverity[] = ["info", "low", "moderate", "high", "critical"]

function isAuditSeverity(value: unknown): value is AuditSeverity {
  return typeof value === "string" && (AUDIT_SEVERITIES as readonly string[]).includes(value)
}

/** Parse the (possibly log-prefixed) audit document for the policy gate. */
export function parseAuditJson(stdout: string): unknown {
  return parseJsonDocument(stdout)
}

/**
 * Parse `npm audit --json` and reject malformed or internally inconsistent
 * output. High/critical entries are returned for the caller to block on; this
 * function has no waiver mechanism.
 */
export function summarizeAudit(stdout: string): AuditSummary {
  const parsed = parseAuditJson(stdout)
  if (!isRecord(parsed) || !isRecord(parsed.vulnerabilities)) {
    throw new Error("npm audit JSON has no vulnerabilities object")
  }
  if (!isRecord(parsed.metadata) || !isRecord(parsed.metadata.vulnerabilities)) {
    throw new Error("npm audit JSON has no metadata.vulnerabilities object")
  }

  const counts: Record<AuditSeverity, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }
  const entries: AuditEntry[] = []
  for (const [key, value] of Object.entries(parsed.vulnerabilities)) {
    if (!isRecord(value)) throw new Error(`npm audit vulnerability ${key} is not an object`)
    if (!isAuditSeverity(value.severity)) {
      throw new Error(`npm audit vulnerability ${key} has an unknown severity`)
    }
    if (!Array.isArray(value.via)) {
      throw new Error(`npm audit vulnerability ${key} has no via array`)
    }
    const advisories: string[] = []
    for (const item of value.via) {
      if (typeof item === "string") {
        advisories.push(item)
      } else if (isRecord(item)) {
        const identifier = typeof item.url === "string" ? item.url : typeof item.title === "string" ? item.title : undefined
        if (!identifier) throw new Error(`npm audit vulnerability ${key} has malformed advisory data`)
        advisories.push(identifier)
      } else {
        throw new Error(`npm audit vulnerability ${key} has malformed advisory data`)
      }
    }
    const name = typeof value.name === "string" && value.name.length > 0 ? value.name : key
    entries.push({ name, severity: value.severity, advisories })
    counts[value.severity] += 1
  }

  for (const severity of AUDIT_SEVERITIES) {
    const reported = parsed.metadata.vulnerabilities[severity]
    if (typeof reported !== "number" || !Number.isInteger(reported) || reported < 0) {
      throw new Error(`npm audit metadata is missing a valid ${severity} count`)
    }
    if (reported !== counts[severity]) {
      throw new Error(`npm audit ${severity} count ${reported} disagrees with entries (${counts[severity]})`)
    }
  }

  return { entries, counts, high: counts.high, critical: counts.critical }
}

function describeBlockingAudit(summary: AuditSummary): string {
  const blocking = summary.entries.filter((entry) => entry.severity === "high" || entry.severity === "critical")
  const lines = blocking.map((entry) => {
    const advisories = entry.advisories.length > 0 ? ` via ${entry.advisories.join("; ")}` : ""
    return `- ${entry.severity}: ${entry.name}${advisories}`
  })
  return `${summary.high} high and ${summary.critical} critical advisory entr${summary.high + summary.critical === 1 ? "y" : "ies"} block release:\n${lines.join("\n")}`
}

export function classifyPublishedLookup(result: CommandResult): PublishedLookup {
  if (result.code === 0) {
    try {
      const parsed = parseJsonDocument(result.stdout)
      if (!isRecord(parsed)) return { status: "error", detail: "npm view returned a non-object" }
      return { status: "published", version: parsed.version, integrity: parsed["dist.integrity"] }
    } catch (error) {
      return { status: "error", detail: error instanceof Error ? error.message : String(error) }
    }
  }
  const info = jsonError(result.stdout)
  const fallback = info.detail ? info : jsonError(result.stderr)
  return { status: "error", code: fallback.code, detail: fallback.detail || tail(result.stderr, 5) }
}

export function publishedArtifactProblem(
  actual: { version?: unknown; integrity?: unknown },
  expected: Pick<ArtifactMetadata, "version" | "integrity">,
): string | null {
  if (actual.version !== expected.version) {
    return `registry version ${String(actual.version)} does not match accepted ${expected.version}`
  }
  if (actual.integrity !== expected.integrity) {
    return `registry integrity ${String(actual.integrity)} does not match accepted ${expected.integrity}`
  }
  return null
}

/** Retry propagation failures every five seconds for up to five minutes of waits;
 * registry request time is additional. Fail immediately on a wrong published artifact. */
export async function verifyPublishedArtifact(
  metadata: ArtifactMetadata,
  lookup: () => PublishedLookup,
  options: { attempts?: number; delayMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<VerificationOutcome> {
  const attempts = options.attempts ?? 61
  const delayMs = options.delayMs ?? 5_000
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms)))
  let last = "no registry response"

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = lookup()
    if (result.status === "published") {
      const problem = publishedArtifactProblem(result, metadata)
      if (!problem) {
        return { ok: true, detail: `registry ${metadata.name}@${metadata.version} matches accepted integrity`, attempts: attempt }
      }
      return { ok: false, detail: problem, attempts: attempt }
    }
    last = `${result.code ? `${result.code}: ` : ""}${result.detail}`
    if (attempt < attempts) await wait(delayMs)
  }
  return {
    ok: false,
    detail: `registry did not report ${metadata.name}@${metadata.version} with the accepted integrity after ${attempts} attempt(s): ${last}`,
    attempts,
  }
}

function repoRoot(): string {
  const result = exec(["git", "rev-parse", "--show-toplevel"], process.cwd())
  requireOk("repo", "git rev-parse --show-toplevel", result)
  return resolve(result.stdout.trim())
}

function readArtifactMetadataFile(path: string): ArtifactMetadata {
  const absolute = resolve(path)
  if (!existsSync(absolute)) throw new Error(`artifact metadata not found: ${absolute}`)
  return validateArtifactMetadata(readJson<unknown>(absolute))
}

async function runVerification(metadataPath: string): Promise<number> {
  try {
    const metadata = readArtifactMetadataFile(metadataPath)
    const outcome = await verifyPublishedArtifact(metadata, () =>
      classifyPublishedLookup(
        exec(["npm", "view", `${metadata.name}@${metadata.version}`, "version", "dist.integrity", "--json"], process.cwd()),
      ),
    )
    if (!outcome.ok) {
      console.error(`\u2717 registry verification failed after ${outcome.attempts} attempt(s): ${outcome.detail}`)
      return 1
    }
    console.log(`\u2713 registry verification passed after ${outcome.attempts} attempt(s): ${outcome.detail}`)
    return 0
  } catch (error) {
    console.error(`\u2717 registry verification failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function runAcceptance(options: Extract<AcceptanceOptions, { mode: "accept" }>): number {
  const passed: string[] = []
  const warnings: string[] = []
  const outputDir = resolve(options.outputDir)
  let scratch: string | undefined

  const pass = (name: string, detail?: string): void => {
    passed.push(name)
    console.log(`\u2713 ${name}${detail ? ` \u2014 ${detail}` : ""}`)
  }
  const warn = (message: string): void => {
    warnings.push(message)
    console.log(`! ${message}`)
  }

  try {
    mkdirSync(outputDir, { recursive: true })
    const root = repoRoot()

    // 1. Preflight: in-scope, non-prerelease version.
    const manifestPath = join(root, "package.json")
    const manifest = readJson<{ name?: string; version?: string }>(manifestPath)
    const name = manifest.name
    const version = manifest.version
    require(typeof name === "string" && name.length > 0, "preflight", "package.json has no name")
    require(typeof version === "string" && version.length > 0, "preflight", "package.json has no version")
    require(!version.includes("-"), "preflight", `version ${version} is a prerelease; acceptance only covers final releases`)
    pass("preflight", `${name}@${version}`)

    const dirty = exec(["git", "status", "--porcelain", "--untracked-files=no"], root)
    requireOk("preflight", "git status --porcelain", dirty)
    if (dirty.stdout.trim()) {
      warn("tracked working tree is dirty; acceptance exports HEAD, not the working tree")
    }

    // 2. Registry guard. Versions are immutable. A duplicate is a hard failure
    // unless the caller explicitly opts into local validation. Registry/auth
    // failures are never bypassable.
    const lookup = classifyRegistryLookup(exec(["npm", "view", `${name}@${version}`, "version", "--json"], root))
    if (lookup.status === "published" && lookup.version !== version) {
      throw new AcceptanceFailure(
        "registry-guard",
        `registry reported ${lookup.version} for ${name}@${version}; refusing to continue`,
      )
    }
    const decision = registryGuardDecision(lookup, { allowPublished: options.allowPublished })
    if (!decision.ok) throw new AcceptanceFailure("registry-guard", decision.detail)
    if (decision.warning) warn(decision.warning)
    pass("registry-guard", decision.detail)

    // 3. Clean export of HEAD. Two steps instead of a shell pipeline so each
    // command's status is checked independently and no pipe can mask a failure.
    // CI should set SCRATCH_ROOT to the approved temporary directory; local
    // runs fall back to the platform temp root.
    const scratchRoot = process.env.SCRATCH_ROOT ?? tmpdir()
    require(existsSync(scratchRoot), "clean-export", `scratch root does not exist: ${scratchRoot}`)
    scratch = mkdtempSync(join(scratchRoot, "tokscope-release."))
    const source = join(scratch, "source")
    mkdirSync(source, { recursive: true })
    const archive = join(scratch, "source.tar")
    requireOk(
      "clean-export",
      "git archive",
      exec(["git", "-C", root, "archive", "--format=tar", "-o", archive, "HEAD"], root),
    )
    requireOk("clean-export", "tar -x", exec(["tar", "-x", "-f", archive, "-C", source], root))
    rmSync(archive, { force: true })
    require(!existsSync(join(source, "dist")), "clean-export", "exported tree already contains dist/")
    require(existsSync(join(source, "LICENSE")), "clean-export", "exported tree is missing LICENSE")
    require(existsSync(join(source, "README.md")), "clean-export", "exported tree is missing README.md")
    const exported = readJson<{ name?: string; version?: string }>(join(source, "package.json"))
    require(
      exported.name === name && exported.version === version,
      "clean-export",
      `exported manifest ${exported.name}@${exported.version} differs from working tree ${name}@${version}`,
    )
    pass("clean-export", `HEAD exported to ${source}`)

    // 4. The export must stand on its own.
    requireOk(
      "export-install",
      "bun install --frozen-lockfile",
      exec(["bun", "install", "--frozen-lockfile"], source),
    )
    pass("export-install", "bun install --frozen-lockfile")

    requireOk("export-test", "bun test", exec(["bun", "test"], source))
    pass("export-test", "bun test")

    requireOk("export-typecheck", "bun run typecheck", exec(["bun", "run", "typecheck"], source))
    pass("export-typecheck", "bun run typecheck")

    // 5. Pack once. Only this artifact may be published.
    const pack = exec(["npm", "pack", "--json", "--pack-destination", scratch], source)
    requireOk("pack", "npm pack --json", pack)
    const packed = parsePackOutput(pack.stdout)
    require(packed.length === 1, "pack", `expected exactly one tarball, npm pack reported ${packed.length}`)
    const pkg = packed[0]
    require(pkg !== undefined, "pack", "npm pack reported no tarball")
    const expectedFilename = `${name}-${version}.tgz`
    require(pkg.filename === expectedFilename, "pack", `unexpected artifact ${pkg.filename}; expected ${expectedFilename}`)
    require(typeof pkg.integrity === "string" && pkg.integrity.length > 0, "pack", "artifact has no integrity")
    require(typeof pkg.shasum === "string" && pkg.shasum.length > 0, "pack", "artifact has no shasum")
    const tarball = join(scratch, pkg.filename)
    require(existsSync(tarball), "pack", `tarball missing at ${tarball}`)
    require(
      sha512SriFile(tarball) === pkg.integrity,
      "pack",
      `tarball SRI ${sha512SriFile(tarball)} does not match npm pack integrity ${pkg.integrity}`,
    )
    pass("pack", `${pkg.filename} (integrity ${pkg.integrity})`)

    // 6. Tar listing must contain exactly the allowlisted artifact paths.
    const listing = exec(["tar", "-tzf", tarball], scratch)
    requireOk("artifact-allowlist", "tar -tzf", listing)
    const entries = listing.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
    const unexpected = entries.filter((entry) => !allowedArtifactFile(entry))
    require(
      unexpected.length === 0,
      "artifact-allowlist",
      `undeclared artifact path(s): ${unexpected.join(", ")}`,
    )
    const missing = ALLOWED_ARTIFACT_FILES.filter((entry) => !entries.includes(entry))
    require(missing.length === 0, "artifact-allowlist", `missing artifact path(s): ${missing.join(", ")}`)
    pass("artifact-allowlist", `${entries.length} file(s), all allowlisted`)

    // 7. Unpack and validate identity, license, access, export, and hooks.
    const unpacked = join(scratch, "unpacked")
    mkdirSync(unpacked, { recursive: true })
    requireOk("manifest", "tar -xzf", exec(["tar", "-xzf", tarball, "-C", unpacked], scratch))
    const packageDir = join(unpacked, "package")
    require(existsSync(join(packageDir, "dist", "tui.js")), "manifest", "tarball is missing dist/tui.js")
    require(existsSync(join(packageDir, "tui.js")), "manifest", "tarball is missing tui.js")
    const installedManifest = readJson<{
      name?: string
      version?: string
      license?: string
      publishConfig?: { access?: string }
      exports?: Record<string, string>
      scripts?: Record<string, string>
    }>(join(packageDir, "package.json"))
    require(
      installedManifest.name === name && installedManifest.version === version,
      "manifest",
      `wrong package identity ${installedManifest.name}@${installedManifest.version}`,
    )
    require(installedManifest.license === "MIT", "manifest", "license is not MIT")
    require(installedManifest.publishConfig?.access === "public", "manifest", "publish access is not public")
    require(
      installedManifest.exports?.["./tui"] === "./dist/tui.js",
      "manifest",
      "TUI export target changed",
    )
    for (const hook of ["preinstall", "install", "postinstall"]) {
      require(!installedManifest.scripts?.[hook], "manifest", `consumer lifecycle hook present: ${hook}`)
    }
    pass("manifest", `${name}@${version}, MIT, public, TUI export intact, no lifecycle hooks`)

    // 8. Host runtimes must stay external string literals.
    const bundle = readFileSync(join(packageDir, "dist", "tui.js"), "utf8")
    for (const specifier of REQUIRED_EXTERNAL_IMPORTS) {
      require(
        bundle.includes(`from "${specifier}"`),
        "host-runtime-externals",
        `host runtime is not external: ${specifier}`,
      )
    }
    pass("host-runtime-externals", REQUIRED_EXTERNAL_IMPORTS.join(", "))

    // 9. No internal reports, secrets, or absolute checkout paths.
    const artifactText = walkFiles(packageDir)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    const leaks = [root, source].filter((rootPath) => bannedArtifactContent(artifactText, rootPath))
    require(leaks.length === 0, "content-scan", `artifact contains internal, secret, or checkout-path material: ${leaks.join(", ")}`)
    pass("content-scan", "no internal report, private key, or absolute checkout path")

    // 10. Consumer install from the tarball only. The consumer is the real
    // production install used for the advisory audit, so it must have a lockfile.
    const consumer = join(scratch, "consumer")
    mkdirSync(consumer, { recursive: true })
    requireOk(
      "consumer-install",
      "npm install tarball",
      exec(
        [
          "npm",
          "install",
          "--prefix",
          consumer,
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          tarball,
        ],
        consumer,
      ),
    )
    require(
      existsSync(join(consumer, "package.json")),
      "consumer-install",
      "consumer install did not produce a package.json",
    )
    require(
      existsSync(join(consumer, "package-lock.json")),
      "consumer-install",
      "consumer install did not produce a package-lock.json",
    )
    const installedDir = join(consumer, "node_modules", name)
    require(
      existsSync(join(installedDir, "dist", "tui.js")),
      "consumer-install",
      `installed package is missing dist/tui.js at ${installedDir}`,
    )
    require(existsSync(join(installedDir, "tui.js")), "consumer-install", `installed package is missing tui.js`)
    const consumerManifest = readJson<{ version?: string }>(join(installedDir, "package.json"))
    require(
      consumerManifest.version === version,
      "consumer-install",
      `installed version ${consumerManifest.version} != ${version}`,
    )
    pass("consumer-install", `${name}@${version} installed with --omit=dev --ignore-scripts`)

    // 11. Advisory audit of the production consumer. Malformed output, network
    // errors, and every untriaged high/critical finding fail closed. After the
    // complete report is validated, one checked and expiry-bound exception may
    // cover only the exact seroval advisories on the pinned assessed chain.
    const audit = exec(["npm", "audit", "--omit=dev", "--json"], consumer)
    const auditJsonPath = join(outputDir, "npm-audit-omit-dev.json")
    writeFileSync(auditJsonPath, audit.stdout)
    if (audit.stderr.trim()) {
      writeFileSync(join(outputDir, "npm-audit-omit-dev.stderr.txt"), audit.stderr)
    }
    require(
      audit.code === 0 || audit.code === 1,
      "consumer-audit",
      `npm audit exited ${audit.code}; stderr (tail):\n${tail(audit.stderr)}`,
    )
    let summary: AuditSummary
    try {
      summary = summarizeAudit(audit.stdout)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new AcceptanceFailure(
        "consumer-audit",
        `npm audit output is not usable: ${reason}\nstdout (tail):\n${tail(audit.stdout)}\nstderr (tail):\n${tail(audit.stderr)}`,
      )
    }
    let exceptionDecision: Extract<AuditExceptionDecision, { allowed: true }> | undefined
    let exceptionEvidencePath: string | undefined
    if (summary.high > 0 || summary.critical > 0) {
      const now = new Date()
      let versions: Map<string, string>
      let decision: AuditExceptionDecision
      try {
        versions = readConsumerVersions(consumer, [
          name,
          ...Object.keys(SEROVAL_AUDIT_EXCEPTION.versions),
        ])
        decision = auditExceptionDecision({
          report: parseAuditJson(audit.stdout),
          root: { name, version },
          versions,
          now,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new AcceptanceFailure(
          "consumer-audit",
          `audit exception could not be evaluated: ${reason}\nEvidence: ${auditJsonPath}`,
        )
      }
      if (!decision.allowed) {
        throw new AcceptanceFailure(
          "consumer-audit",
          `${describeBlockingAudit(summary)}\nAudit exception refused: ${decision.detail}\nEvidence: ${auditJsonPath}`,
        )
      }
      exceptionDecision = decision
      exceptionEvidencePath = join(outputDir, "accepted-audit-exceptions.json")
      writeFileSync(
        exceptionEvidencePath,
        `${JSON.stringify(auditExceptionEvidence(decision, versions, now), null, 2)}\n`,
      )
      warn(
        `scoped audit exception ${SEROVAL_AUDIT_EXCEPTION.id} applied; NOT a clean audit; expires ${SEROVAL_AUDIT_EXCEPTION.expiresAt} (exclusive); evidence ${exceptionEvidencePath}`,
      )
      pass(
        "consumer-audit",
        `${decision.detail}; NOT a clean audit (${jsonSummary(summary.counts)}; evidence ${exceptionEvidencePath})`,
      )
    } else {
      pass("consumer-audit", `no high/critical advisories (${jsonSummary(summary.counts)})`)
    }

    // 12. Preserve exactly the validated tarball plus machine-readable metadata.
    const metadata = preserveArtifact({
      source: tarball,
      outputDir,
      name,
      version,
      filename: pkg.filename,
      integrity: pkg.integrity,
      shasum: pkg.shasum,
    })
    pass("artifact-output", `${metadata.path} (integrity ${metadata.integrity})`)

    // 13. Summary. The artifact hashes are part of release evidence.
    console.log("")
    console.log("Release acceptance summary")
    console.log(`  artifact:  ${metadata.filename}`)
    console.log(`  path:      ${metadata.path}`)
    console.log(`  shasum:    ${metadata.shasum}`)
    console.log(`  integrity: ${metadata.integrity}`)
    console.log(`  sha256:    ${metadata.sha256}`)
    console.log(
      `  audit:     ${jsonSummary(summary.counts)}${
        exceptionDecision ? " (scoped exception applied; NOT a clean audit)" : ""
      } (evidence ${auditJsonPath})`,
    )
    if (exceptionDecision && exceptionEvidencePath) {
      console.log(
        `  exception: ${SEROVAL_AUDIT_EXCEPTION.id}, expires ${SEROVAL_AUDIT_EXCEPTION.expiresAt} (evidence ${exceptionEvidencePath})`,
      )
    }
    if (warnings.length > 0) {
      console.log(`  warnings (${warnings.length}):`)
      for (const warning of warnings) console.log(`    - ${warning}`)
    } else {
      console.log("  warnings:  none")
    }
    console.log(`  checks passed (${passed.length}):`)
    for (const check of passed) console.log(`    \u2713 ${check}`)
    console.log("")
    console.log("Artifact accepted for publication.")
    return 0
  } catch (error) {
    if (error instanceof AcceptanceFailure) {
      console.error(`\u2717 FAILED CHECK: ${error.check}`)
      console.error(error.message)
      if (warnings.length > 0) {
        for (const warning of warnings) console.error(`! ${warning}`)
      }
    } else {
      console.error("\u2717 FAILED CHECK: unexpected-error")
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    }
    console.error(`\u2717 Release acceptance failed; ${passed.length} check(s) passed before the failure.`)
    return 1
  } finally {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true })
      console.log(`scratch cleaned up: ${scratch}`)
    }
  }
}

function jsonSummary(counts: Record<AuditSeverity, number>): string {
  return AUDIT_SEVERITIES.map((severity) => `${severity}=${counts[severity]}`).join(" ")
}

export async function run(options: AcceptanceOptions): Promise<number> {
  return options.mode === "verify" ? runVerification(options.metadataPath) : runAcceptance(options)
}

if (import.meta.main) {
  try {
    process.exitCode = await run(parseAcceptanceArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(`\u2717 ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
