/**
 * Owner-authorized, time-limited audit exception for the seroval advisories.
 *
 * This is deliberately not a package-level or severity-wide waiver. It applies
 * only to the exact advisory URLs below, on the exact dependency chain and
 * resolved versions observed in the production consumer lockfile on
 * 2026-10-24. The root package version is injected from the current artifact
 * manifest, so a release version bump does not require rewriting the waiver;
 * every vulnerable/transitive version stays pinned exactly. The policy gate
 * still runs only after `summarizeAudit` has validated the whole report; any
 * new advisory, package, edge, version, cycle, unresolved via reference, or
 * malformed data fails closed.
 *
 * The exception is not a clean audit. docs/releasing.md §4.1 records the
 * reachability assessment, residual risk, and the review/removal date.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ADVISORY_P6VX = "https://github.com/advisories/GHSA-p6vx-979v-rg4c"
const ADVISORY_JP82 = "https://github.com/advisories/GHSA-jp82-f5mq-hwhp"

/** The explicit tracking issue this exception is authorized against. */
export const SEROVAL_AUDIT_EXPECTED_TRACKING_ISSUE =
  "https://github.com/mihaellenic/opencode-tokscope/issues/2"

export interface AuditExceptionAdvisory {
  package: string
  name: string
  url: string
  severity: "high" | "critical"
}

export interface AuditException {
  id: string
  expiresAt: string
  ownerAuthorization: string
  rationale: string
  trackingIssue: string
  advisories: readonly AuditExceptionAdvisory[]
  /** The released package; its version must match the current artifact manifest. */
  root: string
  /** Exact resolved versions for the vulnerable/transitive components. */
  versions: Readonly<Record<string, string>>
  /** Assessed chain: package -> transitive packages named in its `via` strings. */
  edges: Readonly<Record<string, readonly string[]>>
}

export const SEROVAL_AUDIT_EXCEPTION: AuditException = {
  id: "seroval-ssr-unreachable-2026-11-07",
  expiresAt: "2026-11-07T00:00:00.000Z",
  ownerAuthorization:
    "Owner authorized 2026-10-25: accept only GHSA-p6vx-979v-rg4c and GHSA-jp82-f5mq-hwhp on the pinned host-bound TUI chain through 2026-11-06T23:59:59.999Z. Every other finding, package, path, or version remains blocking.",
  rationale:
    "docs/releasing.md §4.1 records that the affected seroval SSR/fromJSON deserialization paths are unreachable in the supported OpenCode host-bound TUI and that standalone use of the npm dependency tree is unsupported. This exception is not a clean audit and does not cover new advisories or paths.",
  trackingIssue: SEROVAL_AUDIT_EXPECTED_TRACKING_ISSUE,
  advisories: [
    { package: "seroval", name: "seroval", url: ADVISORY_P6VX, severity: "critical" },
    { package: "seroval", name: "seroval", url: ADVISORY_JP82, severity: "high" },
  ],
  root: "opencode-tokscope",
  versions: {
    "@opencode/plugin": "2.1.2",
    "@opentui/solid": "0.6.8",
    "solid-js": "1.9.12",
    seroval: "1.5.6",
  },
  edges: {
    "opencode-tokscope": ["@opencode/plugin", "@opentui/solid"],
    "@opencode/plugin": ["@opentui/solid"],
    "@opentui/solid": ["solid-js"],
    "solid-js": ["seroval"],
    seroval: [],
  },
}

export type AuditExceptionDecision =
  | {
      allowed: true
      applied: boolean
      detail: string
      advisories: string[]
      blockingEntries: string[]
    }
  | { allowed: false; detail: string }

const AUDIT_SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const

interface ParsedVulnerability {
  name: string
  severity: string
  via: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAuditSeverity(value: unknown): value is string {
  return typeof value === "string" && (AUDIT_SEVERITIES as readonly string[]).includes(value)
}

/**
 * Parse the subset of `npm audit --json` needed to resolve advisory roots.
 * `summarizeAudit` has already validated the complete document before this
 * policy gate runs; this parser still fails closed on missing or inconsistent
 * structure so it cannot be called safely in isolation.
 */
function parseVulnerabilities(report: unknown): Map<string, ParsedVulnerability> {
  if (!isRecord(report)) throw new Error("audit report is not an object")
  if (!isRecord(report.vulnerabilities)) throw new Error("audit report has no vulnerabilities object")
  if (!isRecord(report.metadata) || !isRecord(report.metadata.vulnerabilities)) {
    throw new Error("audit report has no metadata.vulnerabilities object")
  }
  const entries = new Map<string, ParsedVulnerability>()
  for (const [key, value] of Object.entries(report.vulnerabilities)) {
    if (!isRecord(value)) throw new Error(`audit vulnerability ${key} is not an object`)
    if (value.name !== key) throw new Error(`audit vulnerability ${key} has a mismatched name`)
    if (!isAuditSeverity(value.severity)) throw new Error(`audit vulnerability ${key} has an unknown severity`)
    if (!Array.isArray(value.via)) throw new Error(`audit vulnerability ${key} has no via array`)
    entries.set(key, { name: key, severity: value.severity, via: value.via })
  }
  return entries
}

function exceptionProblems(exception: AuditException, now: Date): string[] {
  const problems: string[] = []
  if (!Number.isFinite(now.getTime())) problems.push("current time is invalid")
  if (!exception.id.trim()) problems.push("id is empty")
  if (!exception.ownerAuthorization.trim()) problems.push("owner authorization is missing")
  if (!exception.rationale.trim()) problems.push("rationale is missing")
  if (exception.trackingIssue !== SEROVAL_AUDIT_EXPECTED_TRACKING_ISSUE) {
    problems.push(
      `tracking issue ${exception.trackingIssue || "<missing>"} is not the expected ${SEROVAL_AUDIT_EXPECTED_TRACKING_ISSUE}`,
    )
  }
  if (!exception.root.trim()) problems.push("root package is missing")
  if (exception.versions[exception.root] !== undefined) {
    problems.push(`root package ${exception.root} must use the current artifact version, not a literal pin`)
  }
  if (exception.edges[exception.root] === undefined) {
    problems.push(`root package ${exception.root} has no assessed edges`)
  }

  const expiry = Date.parse(exception.expiresAt)
  if (!Number.isFinite(expiry)) {
    problems.push(`expiresAt ${exception.expiresAt} is not a valid timestamp`)
  } else if (Number.isFinite(now.getTime()) && now.getTime() >= expiry) {
    problems.push(`exception expired at ${exception.expiresAt} (exclusive)`)
  }

  if (exception.advisories.length === 0) problems.push("no advisories are approved")
  const urls = new Set<string>()
  for (const advisory of exception.advisories) {
    if (!advisory.package.trim() || !advisory.name.trim()) problems.push("advisory package or name is empty")
    if (!advisory.url.startsWith("https://github.com/advisories/GHSA-")) {
      problems.push(`advisory ${advisory.url} is not an exact GitHub advisory URL`)
    }
    if (urls.has(advisory.url)) problems.push(`advisory ${advisory.url} is listed more than once`)
    urls.add(advisory.url)
    if (advisory.severity !== "high" && advisory.severity !== "critical") {
      problems.push(`advisory ${advisory.url} has an unsupported severity`)
    }
    if (advisory.package !== exception.root && exception.versions[advisory.package] === undefined) {
      problems.push(`advisory package ${advisory.package} has no pinned version`)
    }
  }

  const versions = Object.entries(exception.versions)
  if (versions.length === 0) problems.push("no pinned versions are configured")
  for (const [name, version] of versions) {
    if (!name.trim() || !version.trim()) problems.push("a pinned package name or version is empty")
    if (exception.edges[name] === undefined) problems.push(`pinned package ${name} has no assessed edges`)
  }
  for (const [name, deps] of Object.entries(exception.edges)) {
    if (name !== exception.root && exception.versions[name] === undefined) {
      problems.push(`assessed package ${name} has no pinned version`)
    }
    for (const dep of deps) {
      if (dep !== exception.root && exception.versions[dep] === undefined) {
        problems.push(`assessed edge ${name} -> ${dep} has no pinned version`)
      }
    }
  }
  return problems
}

/**
 * Apply the checked exception to a fully validated npm audit report. Returns
 * `allowed: false` for every condition the exception does not explicitly cover.
 */
export function auditExceptionDecision(input: {
  report: unknown
  /** Current accepted artifact manifest identity, not a literal baseline. */
  root: { name: string; version: string }
  versions: ReadonlyMap<string, string>
  now: Date
  exception?: AuditException
}): AuditExceptionDecision {
  try {
    const entries = parseVulnerabilities(input.report)
    const blocking = [...entries.values()].filter(
      (entry) => entry.severity === "high" || entry.severity === "critical",
    )
    if (blocking.length === 0) {
      return {
        allowed: true,
        applied: false,
        detail: "no high/critical advisories; the exception is not needed",
        advisories: [],
        blockingEntries: [],
      }
    }

    const exception = input.exception ?? SEROVAL_AUDIT_EXCEPTION
    const problems = exceptionProblems(exception, input.now)
    if (problems.length > 0) {
      return { allowed: false, detail: `audit exception is invalid: ${problems.join("; ")}` }
    }
    if (input.root.name !== exception.root) {
      return {
        allowed: false,
        detail: `root package ${input.root.name} does not match exception root ${exception.root}`,
      }
    }
    if (!input.root.version.trim()) return { allowed: false, detail: "current artifact version is missing" }

    const approved = new Map(exception.advisories.map((advisory) => [advisory.url, advisory]))
    const memo = new Map<string, string[]>()
    const visiting = new Set<string>()

    const walk = (name: string): string[] => {
      if (visiting.has(name)) throw new Error(`via cycle involving ${name}`)
      const cached = memo.get(name)
      if (cached) return cached

      const entry = entries.get(name)
      if (!entry) throw new Error(`via reference to ${name} is unresolved`)
      const isRoot = name === exception.root
      const expectedVersion = isRoot ? input.root.version : exception.versions[name]
      if (expectedVersion === undefined) throw new Error(`package ${name} is not on the assessed chain`)
      const installedVersion = input.versions.get(name)
      if (installedVersion === undefined) throw new Error(`no resolved version for ${name}`)
      if (installedVersion !== expectedVersion) {
        throw new Error(
          isRoot
            ? `root package ${name}@${installedVersion} does not match the current artifact version ${expectedVersion}`
            : `${name}@${installedVersion} is outside the pinned ${expectedVersion}`,
        )
      }

      const allowedDeps = exception.edges[name]
      if (!allowedDeps) throw new Error(`package ${name} has no assessed dependency edges`)
      const roots: string[] = []
      visiting.add(name)
      try {
        for (const item of entry.via) {
          if (typeof item === "string") {
            // Resolve first so cycles and unresolved references are reported as
            // such; the edge itself must still be on the assessed chain.
            roots.push(...walk(item))
            if (!allowedDeps.includes(item)) {
              throw new Error(`path ${name} -> ${item} is not on the assessed chain`)
            }
            continue
          }
          if (!isRecord(item)) throw new Error(`vulnerability ${name} has malformed advisory data`)
          if (typeof item.url !== "string" || item.url.length === 0) {
            throw new Error(`vulnerability ${name} advisory is missing a url`)
          }
          const advisory = approved.get(item.url)
          if (!advisory) throw new Error(`advisory ${item.url} is not approved by ${exception.id}`)
          if (advisory.package !== name) throw new Error(`advisory ${item.url} is not on package ${name}`)
          if (item.name !== advisory.name) {
            throw new Error(`advisory name for ${item.url} does not match ${advisory.name}`)
          }
          if (item.severity !== advisory.severity) {
            throw new Error(`advisory severity for ${item.url} does not match ${advisory.severity}`)
          }
          roots.push(item.url)
        }
      } finally {
        visiting.delete(name)
      }

      if (roots.length === 0) throw new Error(`package ${name} does not resolve to an approved advisory`)
      memo.set(name, roots)
      return roots
    }

    const advisories = new Set<string>()
    const blockingEntries: string[] = []
    for (const entry of blocking) {
      for (const root of walk(entry.name)) advisories.add(root)
      blockingEntries.push(entry.name)
    }

    return {
      allowed: true,
      applied: true,
      detail: `scoped exception ${exception.id} covers ${blockingEntries.length} blocking entr${
        blockingEntries.length === 1 ? "y" : "ies"
      }`,
      advisories: [...advisories].sort(),
      blockingEntries: blockingEntries.sort(),
    }
  } catch (error) {
    return { allowed: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export interface AuditExceptionEvidence {
  kind: "accepted-audit-exception"
  generatedAt: string
  exception: {
    id: string
    expiresAt: string
    ownerAuthorization: string
    rationale: string
    trackingIssue: string
    rootPackage: string
    advisories: AuditExceptionAdvisory[]
  }
  appliedTo: {
    blockingEntries: string[]
    advisories: string[]
    resolvedVersions: Record<string, string>
  }
  residualRisk: string
}

/** Evidence kept separate from the untouched raw npm audit JSON. */
export function auditExceptionEvidence(
  decision: Extract<AuditExceptionDecision, { allowed: true }>,
  versions: ReadonlyMap<string, string>,
  now: Date,
  exception: AuditException = SEROVAL_AUDIT_EXCEPTION,
): AuditExceptionEvidence {
  return {
    kind: "accepted-audit-exception",
    generatedAt: now.toISOString(),
    exception: {
      id: exception.id,
      expiresAt: exception.expiresAt,
      ownerAuthorization: exception.ownerAuthorization,
      rationale: exception.rationale,
      trackingIssue: exception.trackingIssue,
      rootPackage: exception.root,
      advisories: exception.advisories.map((advisory) => ({ ...advisory })),
    },
    appliedTo: {
      blockingEntries: [...decision.blockingEntries],
      advisories: [...decision.advisories],
      resolvedVersions: Object.fromEntries([...versions.entries()].sort(([a], [b]) => a.localeCompare(b))),
    },
    residualRisk:
      "NOT a clean audit. The approved seroval advisories remain present in the published dependency tree. Acceptance is limited to the documented unreachable SSR/fromJSON paths in the supported host-bound TUI; standalone use of the npm-installed tree is unsupported and may still be affected. Any new advisory, package, path, version, cycle, unresolved reference, or malformed report remains blocking. Re-review and remove this exception before it expires.",
  }
}

/** Read exact installed versions for the configured packages from a consumer lockfile. */
export function readConsumerVersions(consumerDir: string, names: readonly string[]): Map<string, string> {
  const lockPath = join(consumerDir, "package-lock.json")
  const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"))
  if (!isRecord(parsed) || !isRecord(parsed.packages)) {
    throw new Error(`consumer lockfile ${lockPath} has no packages object`)
  }

  const versions = new Map<string, string>()
  for (const name of names) {
    const suffix = `node_modules/${name}`
    const found = new Set<string>()
    for (const [key, value] of Object.entries(parsed.packages)) {
      if (key !== suffix && !key.endsWith(`/${suffix}`)) continue
      if (!isRecord(value) || typeof value.version !== "string") {
        throw new Error(`consumer lockfile entry ${key} has no version`)
      }
      found.add(value.version)
    }
    if (found.size === 0) throw new Error(`consumer lockfile has no resolved version for ${name}`)
    if (found.size > 1) {
      throw new Error(`consumer lockfile has multiple resolved versions for ${name}: ${[...found].join(", ")}`)
    }
    versions.set(name, [...found][0] as string)
  }
  return versions
}
