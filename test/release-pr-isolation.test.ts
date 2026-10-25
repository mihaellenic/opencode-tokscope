import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const workflow = readFileSync(join(root, ".github/workflows/validate-release-pr.yml"), "utf8")

const repository = "mihaellenic/opencode-tokscope"
const releaseRef = "release-please--branches--main"
const headSha = "a".repeat(40)
const baseSha = "b".repeat(40)
const movedSha = "c".repeat(40)

/** Extract a named step's inline shell body so it can run without a GitHub runner. */
function runBlock(source: string, stepName: string): string {
  const lines = source.split("\n")
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`)
  if (stepIndex === -1) throw new Error(`step ${stepName} not found`)
  const stepIndent = (lines[stepIndex] as string).length - (lines[stepIndex] as string).trimStart().length
  let stepEnd = lines.length
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (line.trim() === "") continue
    const indent = line.length - line.trimStart().length
    if (indent === stepIndent && line.trimStart().startsWith("- ")) {
      stepEnd = index
      break
    }
  }
  const step = lines.slice(stepIndex, stepEnd)
  const runIndex = step.findIndex((line) => /^\s*run:\s*\|\s*$/.test(line))
  if (runIndex === -1) throw new Error(`step ${stepName} has no multi-line run body`)
  const runIndent = ((step[runIndex] as string).match(/^\s*/) as RegExpMatchArray)[0].length
  const body: string[] = []
  for (let index = runIndex + 1; index < step.length; index += 1) {
    const line = step[index] as string
    if (line.trim() === "") {
      body.push("")
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent <= runIndent) break
    body.push(line.slice(runIndent + 2))
  }
  return body.join("\n").trimEnd()
}

type PullOverrides = {
  state?: string
  baseRef?: string
  baseSha?: string
  headRef?: string
  headSha?: string
  headRepo?: string
}

function pullRequest(overrides: PullOverrides = {}) {
  return {
    number: 1,
    state: overrides.state ?? "open",
    base: { ref: overrides.baseRef ?? "main", sha: overrides.baseSha ?? baseSha },
    head: {
      ref: overrides.headRef ?? releaseRef,
      sha: overrides.headSha ?? headSha,
      repo: { full_name: overrides.headRepo ?? repository },
    },
  }
}

function identityEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_REPOSITORY: repository,
    PR: "1",
    HEAD_SHA: headSha,
    EVENT_HEAD_REPO: repository,
    EVENT_HEAD_REF: releaseRef,
    EVENT_BASE_REF: "main",
    ...overrides,
  }
}

function freshnessEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_REPOSITORY: repository,
    GH_TOKEN: "test-token",
    PR: "1",
    HEAD_SHA: headSha,
    ...overrides,
  }
}

type StepOptions = {
  pull?: unknown
  pullRaw?: string
  env?: Record<string, string | undefined>
  ghFails?: boolean
  artifactFiles?: Record<string, string>
}

type StepRun = {
  exitCode: number
  stdout: string
  stderr: string
  output: string
  summary: string
  dir: string
}

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function runStep(stepName: string, options: StepOptions = {}): StepRun {
  const dir = mkdtempSync(join(tmpdir(), "release-pr-isolation-"))
  scratch.push(dir)
  const bin = join(dir, "bin")
  mkdirSync(bin)
  const gh = join(bin, "gh")
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      'if [ "${GH_FIXTURE_FAIL:-0}" = "1" ]; then',
      '  echo "gh: fixture failure" >&2',
      "  exit 1",
      "fi",
      'exec cat "$GH_FIXTURE"',
      "",
    ].join("\n"),
  )
  chmodSync(gh, 0o755)

  const fixture = join(dir, "pull.json")
  writeFileSync(fixture, options.pullRaw ?? JSON.stringify(options.pull ?? pullRequest(), null, 2))
  const output = join(dir, "github-output")
  writeFileSync(output, "")
  const summary = join(dir, "github-summary")
  writeFileSync(summary, "")
  const artifactDir = join(dir, "artifact")
  mkdirSync(artifactDir)
  for (const [name, content] of Object.entries(options.artifactFiles ?? {})) {
    writeFileSync(join(artifactDir, name), content)
  }

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    GH_FIXTURE: fixture,
    GH_FIXTURE_FAIL: options.ghFails ? "1" : "0",
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    ARTIFACT_DIR: artifactDir,
    ...options.env,
  })) {
    if (value !== undefined) env[key] = value
  }

  const result = spawnSync("bash", ["-c", runBlock(workflow, stepName)], {
    cwd: dir,
    env,
    encoding: "utf8",
  })
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
    dir,
  }
}

function outputs(run: StepRun): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const line of run.output.split("\n")) {
    const separator = line.indexOf("=")
    if (separator > 0) parsed[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return parsed
}

function headStatus(run: StepRun) {
  return JSON.parse(readFileSync(join(run.dir, "artifact", "head-status.json"), "utf8")) as {
    expected_sha: string
    observed_sha: string | null
    pr_state: string | null
    outcome: string
  }
}

const precheck = "Validate PR identity through the GitHub API"
const freshness = "Verify current PR head"
const evidence = "Require accepted evidence"
const summaryStep = "Summarize validation and acceptance evidence"

describe("release PR identity pre-check", () => {
  test("accepts an open same-repo release PR at the event head", () => {
    const run = runStep(precheck, { pull: pullRequest(), env: identityEnv() })
    expect(run.exitCode).toBe(0)
    expect(outputs(run).base_sha).toBe(baseSha)
  })

  const rejected: Array<{ name: string; overrides?: PullOverrides; env?: Record<string, string>; ghFails?: boolean }> = [
    { name: "an event head that no longer matches the live PR head", overrides: { headSha: movedSha } },
    { name: "an invalid event head SHA", env: { HEAD_SHA: "not-a-sha" } },
    { name: "an empty event head SHA", env: { HEAD_SHA: "" } },
    { name: "a non-numeric PR number", env: { PR: "not-a-number" } },
    {
      name: "a fork head reported by the event",
      env: { EVENT_HEAD_REPO: "contributor/opencode-tokscope" },
    },
    {
      name: "a fork head returned by the live API with matching event fields",
      overrides: { headRepo: "contributor/opencode-tokscope" },
      env: { EVENT_HEAD_REPO: "contributor/opencode-tokscope" },
    },
    { name: "a closed PR", overrides: { state: "closed" } },
    {
      name: "a live PR targeting another base branch",
      overrides: { baseRef: "develop" },
      env: { EVENT_BASE_REF: "develop" },
    },
    { name: "an event base branch that differs from the live base", env: { EVENT_BASE_REF: "develop" } },
    {
      name: "a live head ref that is not a release-please branch",
      overrides: { headRef: "feature/not-a-release" },
      env: { EVENT_HEAD_REF: "feature/not-a-release" },
    },
    { name: "an event head ref that differs from the live head ref", env: { EVENT_HEAD_REF: "feature/other" } },
    { name: "a malformed base SHA", overrides: { baseSha: "not-a-sha" } },
    { name: "a short base SHA", overrides: { baseSha: "b".repeat(39) } },
    { name: "an empty live head SHA", overrides: { headSha: "" } },
    { name: "a GitHub API failure", ghFails: true },
  ]

  for (const fixture of rejected) {
    test(`rejects ${fixture.name}`, () => {
      const run = runStep(precheck, {
        pull: pullRequest(fixture.overrides),
        env: identityEnv(fixture.env),
        ghFails: fixture.ghFails,
      })
      expect(run.exitCode).not.toBe(0)
      expect(run.output).not.toContain("base_sha=")
    })
  }
})

describe("current PR head verification", () => {
  test("records the current validated head", () => {
    const run = runStep(freshness, { pull: pullRequest(), env: freshnessEnv() })
    expect(run.exitCode).toBe(0)
    expect(headStatus(run)).toEqual({
      expected_sha: headSha,
      observed_sha: headSha,
      pr_state: "open",
      outcome: "current",
    })
  })

  test("fails and records a stale head", () => {
    const run = runStep(freshness, { pull: pullRequest({ headSha: movedSha }), env: freshnessEnv() })
    expect(run.exitCode).not.toBe(0)
    expect(headStatus(run)).toEqual({
      expected_sha: headSha,
      observed_sha: movedSha,
      pr_state: "open",
      outcome: "stale",
    })
  })

  test("fails and records a closed PR", () => {
    const run = runStep(freshness, { pull: pullRequest({ state: "closed" }), env: freshnessEnv() })
    expect(run.exitCode).not.toBe(0)
    expect(headStatus(run)).toEqual({
      expected_sha: headSha,
      observed_sha: headSha,
      pr_state: "closed",
      outcome: "closed",
    })
  })

  test("records unverified before failing when the API call fails", () => {
    const run = runStep(freshness, { ghFails: true, env: freshnessEnv() })
    expect(run.exitCode).not.toBe(0)
    expect(headStatus(run)).toEqual({
      expected_sha: headSha,
      observed_sha: null,
      pr_state: null,
      outcome: "unverified",
    })
  })

  const unusableResponses: Array<{
    name: string
    raw: string
    observed?: string | null
    state?: string | null
  }> = [
    { name: "malformed JSON", raw: "{not-json" },
    { name: "an empty response body", raw: "" },
    { name: "a non-object response", raw: "[]" },
    { name: "a null response", raw: "null" },
    {
      name: "a non-string live head SHA",
      raw: JSON.stringify({ head: { sha: 42 }, state: "open" }),
    },
    {
      name: "a non-string PR state",
      raw: JSON.stringify({ head: { sha: headSha }, state: null }),
    },
    {
      name: "a malformed live head SHA",
      raw: JSON.stringify({ head: { sha: "not-a-sha" }, state: "open" }),
      observed: "not-a-sha",
      state: "open",
    },
    {
      name: "an unknown PR state",
      raw: JSON.stringify({ head: { sha: headSha }, state: "merged" }),
      observed: headSha,
      state: "merged",
    },
  ]

  for (const fixture of unusableResponses) {
    test(`fails closed with an unverified snapshot for ${fixture.name}`, () => {
      const run = runStep(freshness, { pullRaw: fixture.raw, env: freshnessEnv() })
      expect(run.exitCode).not.toBe(0)
      expect(headStatus(run)).toEqual({
        expected_sha: headSha,
        observed_sha: fixture.observed ?? null,
        pr_state: fixture.state ?? null,
        outcome: "unverified",
      })
    })
  }
})

const gateEnv = (overrides: Record<string, string | undefined> = {}) => ({
  ACCEPTANCE: "success",
  ARTIFACT: "accepted",
  AUDIT: "no-high-critical",
  FRESHNESS: "success",
  ...overrides,
})

describe("accepted evidence gate", () => {
  test("accepts an exact package with a clean consumer audit and a current head", () => {
    const run = runStep(evidence, { env: gateEnv() })
    expect(run.exitCode).toBe(0)
  })

  test("accepts an exact package with a scoped audit exception and a current head", () => {
    const run = runStep(evidence, { env: gateEnv({ AUDIT: "exception-applied" }) })
    expect(run.exitCode).toBe(0)
  })

  const rejected: Array<{ name: string; env: Record<string, string | undefined> }> = [
    { name: "failed artifact acceptance", env: gateEnv({ ACCEPTANCE: "failure" }) },
    { name: "skipped artifact acceptance", env: gateEnv({ ACCEPTANCE: "skipped" }) },
    { name: "acceptance that never ran", env: gateEnv({ ACCEPTANCE: "not-run" }) },
    { name: "an empty acceptance outcome", env: gateEnv({ ACCEPTANCE: "" }) },
    { name: "an unavailable artifact", env: gateEnv({ ARTIFACT: "unavailable" }) },
    { name: "an artifact that was not produced", env: gateEnv({ ARTIFACT: "not-produced" }) },
    { name: "an unreadable artifact", env: gateEnv({ ARTIFACT: "unreadable" }) },
    { name: "a blocking audit", env: gateEnv({ AUDIT: "blocking" }) },
    { name: "an unverified audit", env: gateEnv({ AUDIT: "unverified" }) },
    { name: "an unusable audit", env: gateEnv({ AUDIT: "unusable" }) },
    { name: "an empty audit outcome", env: gateEnv({ AUDIT: "" }) },
    { name: "an unknown audit outcome", env: gateEnv({ AUDIT: "clean" }) },
    { name: "failed head freshness", env: gateEnv({ FRESHNESS: "failure" }) },
    { name: "skipped head freshness", env: gateEnv({ FRESHNESS: "skipped" }) },
    { name: "head freshness that never ran", env: gateEnv({ FRESHNESS: "not-run" }) },
    { name: "missing evidence outputs", env: {} },
  ]

  for (const fixture of rejected) {
    test(`rejects ${fixture.name}`, () => {
      const run = runStep(evidence, { env: fixture.env })
      expect(run.exitCode).not.toBe(0)
    })
  }
})

const artifactJson = JSON.stringify({
  name: "opencode-tokscope",
  version: "0.1.0",
  filename: "opencode-tokscope-0.1.0.tgz",
  integrity: "sha512-abc",
})

const cleanAudit = JSON.stringify({ metadata: { vulnerabilities: { high: 0, critical: 0 } } })

function summaryEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_REPOSITORY: repository,
    PR: "1",
    HEAD_SHA: headSha,
    ACCEPTANCE: "success",
    INSTALL: "success",
    TYPECHECK: "success",
    TEST: "success",
    BUILD: "success",
    SUBJECTS: "success",
    FRESHNESS: "success",
    EVIDENCE_ARTIFACT: "release-pr-evidence-1-1",
    ...overrides,
  }
}

function headStatusFile(overrides: Record<string, string | null> = {}) {
  return JSON.stringify({
    expected_sha: headSha,
    observed_sha: headSha,
    pr_state: "open",
    outcome: "current",
    ...overrides,
  })
}

describe("validation and acceptance summary", () => {
  test("labels a skipped freshness check not-run and keeps earlier failures visible", () => {
    const run = runStep(summaryStep, {
      env: summaryEnv({
        ACCEPTANCE: "failure",
        TEST: "failure",
        BUILD: "skipped",
        SUBJECTS: "skipped",
        FRESHNESS: "not-run",
      }),
    })
    expect(run.exitCode).toBe(0)
    expect(run.summary).toContain("Head freshness")
    expect(run.summary).toContain("not-run")
    expect(run.summary).toContain("no accepted artifact was preserved")
    expect(run.summary).toContain("install=success typecheck=success test=failure build=skipped subjects=skipped")
    expect(run.summary).toContain("**failure**")
  })

  test("distinguishes an accepted package from a stale PR head", () => {
    const run = runStep(summaryStep, {
      env: summaryEnv({ FRESHNESS: "failure" }),
      artifactFiles: {
        "artifact.json": artifactJson,
        "npm-audit-omit-dev.json": cleanAudit,
        "head-status.json": headStatusFile({ observed_sha: movedSha, outcome: "stale" }),
      },
    })
    expect(run.exitCode).toBe(0)
    expect(run.summary).toContain("accepted opencode-tokscope@0.1.0")
    expect(run.summary).toContain("stale")
    expect(run.summary).toContain(movedSha)
    expect(run.summary).toContain("does not verify publication")
  })

  test("distinguishes a closed PR from an accepted package", () => {
    const run = runStep(summaryStep, {
      env: summaryEnv({ FRESHNESS: "failure" }),
      artifactFiles: {
        "artifact.json": artifactJson,
        "npm-audit-omit-dev.json": cleanAudit,
        "head-status.json": headStatusFile({ pr_state: "closed", outcome: "closed" }),
      },
    })
    expect(run.summary).toContain("accepted opencode-tokscope@0.1.0")
    expect(run.summary).toContain("closed")
  })

  test("distinguishes an unverified head from an accepted package", () => {
    const run = runStep(summaryStep, {
      env: summaryEnv({ FRESHNESS: "failure" }),
      artifactFiles: {
        "artifact.json": artifactJson,
        "npm-audit-omit-dev.json": cleanAudit,
        "head-status.json": headStatusFile({ observed_sha: null, pr_state: null, outcome: "unverified" }),
      },
    })
    expect(run.summary).toContain("accepted opencode-tokscope@0.1.0")
    expect(run.summary).toContain("unverified")
  })

  test("reports a current package as current without claiming publication", () => {
    const run = runStep(summaryStep, {
      env: summaryEnv(),
      artifactFiles: {
        "artifact.json": artifactJson,
        "npm-audit-omit-dev.json": cleanAudit,
        "head-status.json": headStatusFile(),
      },
    })
    expect(run.summary).toContain("accepted opencode-tokscope@0.1.0")
    expect(run.summary).toContain("current")
    expect(run.summary).not.toContain("publication verified")
    expect(run.summary).not.toContain("publish verified")
  })

  test("keeps blocking audit values and the scoped-exception warning distinct", () => {
    const blocking = runStep(summaryStep, {
      env: summaryEnv({ ACCEPTANCE: "failure", FRESHNESS: "not-run" }),
      artifactFiles: {
        "npm-audit-omit-dev.json": JSON.stringify({
          metadata: { vulnerabilities: { high: 1, critical: 2 } },
        }),
      },
    })
    expect(outputs(blocking).audit).toBe("blocking")
    expect(blocking.summary).toContain("blocking high=1 critical=2")

    const exception = runStep(summaryStep, {
      env: summaryEnv({ FRESHNESS: "not-run" }),
      artifactFiles: {
        "artifact.json": artifactJson,
        "accepted-audit-exceptions.json": "{}",
        "head-status.json": headStatusFile(),
      },
    })
    expect(outputs(exception).audit).toBe("exception-applied")
    expect(exception.summary).toContain("NOT a clean audit")
  })
})
