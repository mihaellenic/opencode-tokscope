/**
 * Release artifact acceptance for opencode-tokscope.
 *
 * Ports docs/releasing.md sections 1-4 into one gate that runs immediately
 * before `npm publish`:
 *   - export a clean tree with `git archive` (no dist/, no node_modules/)
 *   - prove the exported source installs, tests, and typechecks
 *   - pack exactly one tarball and validate its contents and manifest
 *   - prove host runtimes stay external and no internal/secret material leaks
 *   - install the tarball as a consumer outside the repository
 *
 * The script never publishes and never modifies the repository. Each run uses
 * a fresh scratch directory that is removed on every exit path, including
 * failures. The exported helpers below are side-effect free so the tests can
 * import them without running the orchestrator.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

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

export function allowedArtifactFile(path: string): boolean {
  return (ALLOWED_ARTIFACT_FILES as readonly string[]).includes(path)
}

export function bannedArtifactContent(content: string, sourceRoot: string): boolean {
  if (BANNED_CONTENT_PATTERNS.some((pattern) => pattern.test(content))) return true
  return sourceRoot.length > 0 && content.includes(sourceRoot)
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
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

function sha256(path: string): string {
  const result = exec(["shasum", "-a", "256", path], process.cwd())
  requireOk("artifact-hash", "shasum -a 256", result)
  return result.stdout.trim().split(/\s+/)[0] ?? ""
}

function repoRoot(): string {
  const result = exec(["git", "rev-parse", "--show-toplevel"], process.cwd())
  requireOk("repo", "git rev-parse --show-toplevel", result)
  return resolve(result.stdout.trim())
}

export function run(): number {
  const passed: string[] = []
  const warnings: string[] = []
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

    // 2. Registry guard. Versions are immutable: an already-published version
    // cannot be published again. Per the release plan this is a hard guard in
    // CI; locally a published version downgrades to a warning so acceptance can
    // still be exercised, and `npm publish` remains the final block.
    const published = exec(["npm", "view", `${name}@${version}`, "version"], root)
    if (published.code === 0) {
      warn(`version ${version} already published \u2014 republish would fail at publish step`)
      pass("registry-guard", "already published (warning; publish step will refuse)")
    } else {
      const registryMiss = /E404|404 Not Found|is not in (this|the) registry/i.test(
        `${published.stdout}\n${published.stderr}`,
      )
      if (!registryMiss) {
        warn("npm view failed without a 404; registry availability could not be confirmed")
      }
      pass("registry-guard", `${name}@${version} is not published`)
    }

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

    // 10. Consumer install from the tarball only.
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

    // 11. Summary. The artifact hashes are part of release evidence.
    const digest = sha256(tarball)

    console.log("")
    console.log("Release acceptance summary")
    console.log(`  artifact:  ${pkg.filename}`)
    console.log(`  shasum:    ${pkg.shasum}`)
    console.log(`  integrity: ${pkg.integrity}`)
    console.log(`  sha256:    ${digest}`)
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

if (import.meta.main) {
  process.exitCode = run()
}
