import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const read = (path: string): string => readFileSync(join(root, path), "utf8")

const ci = read(".github/workflows/ci.yml")
const release = read(".github/workflows/release.yml")
const validate = read(".github/workflows/validate-release-pr.yml")

/** Extract a top-level job block so permission assertions cannot match another job. */
function jobBlock(source: string, name: string): string {
  const marker = `\n  ${name}:\n`
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`job ${name} not found`)
  const rest = source.slice(start + marker.length)
  const next = rest.search(/\n  [a-zA-Z0-9_-]+:\n/)
  return next === -1 ? rest : rest.slice(0, next)
}

/** Run steps, multi-line or single-line; event context must be passed through env, never interpolated into shell source. */
function runBlocks(source: string): string[] {
  const blocks: string[] = []
  let current: string[] | undefined
  let blockIndent = 0
  for (const line of source.split("\n")) {
    if (current === undefined) {
      const match = /^(\s*)(?:-\s+)?run: \|\s*$/.exec(line)
      if (match) {
        current = []
        blockIndent = match[1]?.length ?? 0
        continue
      }
      const single = /^(\s*)(?:-\s+)?run:\s+(.+)$/.exec(line)
      if (single?.[2]) blocks.push(single[2])
      continue
    }
    if (line.trim() === "") {
      current.push(line)
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent <= blockIndent) {
      blocks.push(current.join("\n"))
      current = undefined
    } else {
      current.push(line)
    }
  }
  if (current !== undefined) blocks.push(current.join("\n"))
  return blocks
}

describe("CI workflow structure", () => {
  test("checks out and validates the real PR head against the real base SHA", () => {
    expect(ci).toContain(
      "ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
    )
    expect(ci).toContain("PR_BASE: ${{ github.event.pull_request.base.sha }}")
    expect(ci).toContain("PR_HEAD: ${{ github.event.pull_request.head.sha }}")
    expect(ci).toContain('git log --format=\'%s\' "$base..$head"')
    expect(ci).not.toContain("github.base_ref")
  })

  test("queries subjects once, without a duplicate collection step, and fails closed", () => {
    expect(ci).not.toContain("id: range")
    expect(ci).not.toContain("%H %s")
    expect(ci).not.toContain("skipping subject check")
    expect(ci).not.toContain("|| echo")
    expect(ci).toContain("all reachable history")
    expect(ci).toContain("test -n \"$head\"")
  })

  test("passes event values through env instead of shell interpolation", () => {
    expect(runBlocks(ci).length).toBeGreaterThan(0)
    for (const block of runBlocks(ci)) expect(block).not.toContain("${{")
  })

  test("extracts single-line run steps as well as multi-line bodies", () => {
    const blocks = runBlocks("      - run: echo ${{ github.sha }}\n      - run: |\n          echo ok\n")
    expect(blocks).toContain("echo ${{ github.sha }}")
    expect(blocks[1]).toContain("echo ok")
  })

  test("pins the installed Bun version", () => {
    expect(ci).toContain("bun-version: 1.1.3")
    expect(release).toContain("bun-version: 1.1.3")
    expect(validate).toContain("bun-version: 1.1.3")
  })
})

describe("release workflow security and gating", () => {
  test("publish is least privilege", () => {
    const publish = jobBlock(release, "publish")
    expect(publish).toContain("permissions:\n      contents: read\n      id-token: write")
    expect(publish).not.toContain("pull-requests: write")
    expect(publish).not.toContain("contents: write")
    expect(publish).not.toContain("actions: write")
  })

  test("has no stored npm credential or registry auth file", () => {
    expect(release).not.toContain("NODE_AUTH_TOKEN")
    expect(release).not.toContain("NPM_TOKEN")
    expect(release).not.toContain("secrets.")
    expect(release).not.toContain("registry-url")
    expect(release).not.toContain("--allow-published")
    expect(validate).not.toContain("--allow-published")
  })

  test("sets up Node and pins npm before every npm operation", () => {
    const node = release.indexOf("actions/setup-node@v5")
    const npmPin = release.indexOf("npm install -g npm@11.16.0")
    const acceptance = release.indexOf("release-acceptance.ts --output-dir")
    const publish = release.indexOf('npm publish "$tarball"')
    const verify = release.indexOf("--verify-published")

    expect(node).toBeGreaterThan(-1)
    expect(node).toBeLessThan(npmPin)
    expect(npmPin).toBeLessThan(acceptance)
    expect(npmPin).toBeLessThan(publish)
    expect(publish).toBeLessThan(verify)
    expect(release).toContain("node-version: 24")
    expect(release).toContain("package-manager-cache: false")
    expect(release).toContain('test "$(npm --version)" = "11.16.0"')
    expect(release).not.toContain("npm@latest")
  })

  test("publishes the accepted tarball, not a checkout build", () => {
    expect(release).toContain("release-acceptance.ts --output-dir \"$ARTIFACT_DIR\"")
    expect(release).toContain('tarball=$(node -p \'require(process.env.ARTIFACT_DIR + "/artifact.json").path\')')
    expect(release).toContain('npm publish "$tarball" --access public')
    expect(release).toContain("--verify-published \"$ARTIFACT_DIR/artifact.json\"")
  })

  test("keeps the repo-level advisory audit out of the workflow", () => {
    expect(release).not.toContain("npm audit")
    expect(release).not.toContain("continue-on-error")
    expect(release).toContain("Preserve acceptance evidence")
    expect(release).toContain("if: always()")
  })

  test("checks out an exact release tag and supports validated recovery", () => {
    expect(release).toContain("workflow_dispatch:")
    expect(release).toContain("release_tag:")
    expect(release).toContain("        required: true")
    expect(release).toContain("ref: ${{ steps.resolve.outputs.tag }}")
    expect(release).toContain("releases/tags/$tag")
    expect(release).toContain('test "$draft" = "false"')
    expect(release).toContain('test "$version" = "${RELEASE_TAG#v}"')
    expect(release).toContain('git describe --tags --exact-match HEAD')
  })

  test("serializes release runs without cancelling the active one", () => {
    expect(release).toContain("concurrency:\n  group: release\n  cancel-in-progress: false")
  })

  test("pins the Node 24 release-please action and keeps its publishing outputs", () => {
    const job = jobBlock(release, "release-please")
    expect(job).toContain("uses: googleapis/release-please-action@v5")
    expect(job).not.toContain("googleapis/release-please-action@v4")
    expect(job).toContain("config-file: release-please-config.json")
    expect(job).toContain("manifest-file: .release-please-manifest.json")
    expect(job).toContain("release_created: ${{ steps.release.outputs.release_created }}")
    expect(job).toContain("tag_name: ${{ steps.release.outputs.tag_name }}")
    expect(job).not.toContain("prs_created")
    expect(job).not.toContain("outputs.pr }}")
  })

  test("has no release PR dispatch path", () => {
    expect(release).not.toContain("\n  validate-release-pr:\n")
    expect(release).not.toContain("gh workflow run")
    expect(release).not.toContain("gh run watch")
    expect(release).not.toContain("actions: write")
    expect(release).not.toContain("REQUEST_ID")
    expect(release).not.toContain("request_id")
    expect(release).not.toContain("prs_created")
    expect(release).not.toContain("actions/workflows/validate-release-pr.yml/runs")
    expect(release).not.toContain("head_sha")
    expect(release).not.toContain("expected_title")

    const dispatchInputs = release.slice(
      release.indexOf("workflow_dispatch:"),
      release.indexOf("\npermissions:"),
    )
    expect(dispatchInputs.match(/^ {6}[a-z0-9_-]+:$/gm)).toEqual(["      release_tag:"])
  })

  test("retains independent tagged artifact publishing", () => {
    const publish = jobBlock(release, "publish")
    expect(publish).toContain("needs: release-please")
    expect(publish).toContain(
      "if: always() && ((github.event_name == 'push' && needs.release-please.outputs.release_created == 'true') || github.event_name == 'workflow_dispatch')",
    )
    expect(publish).toContain("ref: ${{ steps.resolve.outputs.tag }}")
    expect(publish).toContain('bun scripts/release-acceptance.ts --output-dir "$ARTIFACT_DIR"')
    expect(publish).toContain('npm publish "$tarball" --access public')
    expect(publish).toContain('--verify-published "$ARTIFACT_DIR/artifact.json"')
    expect(publish).not.toContain("release-pr-evidence")
    expect(release).not.toContain("release-pr-evidence")
    expect(release).not.toContain("actions/download-artifact")
  })

  test("passes event and input values through env instead of shell interpolation", () => {
    expect(runBlocks(release).length).toBeGreaterThan(0)
    for (const block of runBlocks(release)) expect(block).not.toContain("${{")
  })
})

describe("release PR validation workflow", () => {
  test("executes release PR code only on pull_request", () => {
    expect(validate).toContain(
      "on:\n  pull_request:\n    branches: [main]\n    types: [opened, synchronize, reopened]",
    )
    for (const forbidden of [
      "workflow_dispatch",
      "pull_request_target",
      "repository_dispatch",
      "workflow_run",
      "push:",
    ]) {
      expect(validate).not.toContain(forbidden)
    }
    const validateJob = jobBlock(validate, "validate")
    expect(validateJob).toContain("name: release-pr-validation")
    expect(validateJob).toContain(
      "if: github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.event.pull_request.head.ref, 'release-please--')",
    )
    expect(validate).toContain(
      "concurrency:\n  group: validate-release-pr-${{ github.event.pull_request.number }}\n  cancel-in-progress: false",
    )
    expect(validate).toContain(
      "run-name: 'Validate release PR #${{ github.event.pull_request.number }}'",
    )
    expect(validate).not.toContain("inputs.")
    expect(validate).not.toContain("request_id")
    expect(validate).not.toContain("REQUEST_ID")
  })

  test("uses the event head rather than the merge SHA", () => {
    const validateJob = jobBlock(validate, "validate")
    expect(validateJob).toContain("ref: ${{ github.event.pull_request.head.sha }}")
    expect(validateJob).toContain("persist-credentials: false")
    expect(validateJob).not.toContain("github.sha")
    expect(validateJob).not.toContain("refs/pull/")
    expect(validateJob).toContain("HEAD_SHA: ${{ github.event.pull_request.head.sha }}")
    expect(validateJob).toContain('test "$(git rev-parse HEAD)" = "$HEAD_SHA"')
    expect(validateJob).toContain("fetch-depth: 0")
  })

  test("validates the live PR identity before checkout", () => {
    const validateJob = jobBlock(validate, "validate")
    const precheck = validateJob.indexOf("Validate PR identity through the GitHub API")
    const checkout = validateJob.indexOf("actions/checkout@v5")
    expect(precheck).toBeGreaterThan(-1)
    expect(precheck).toBeLessThan(checkout)
    expect(validateJob).toContain('gh api "repos/$GITHUB_REPOSITORY/pulls/$PR"')
    expect(validateJob).toContain('test "$actual_sha" = "$HEAD_SHA"')
    expect(validateJob).toContain('test "$state" = "open"')
    expect(validateJob).toContain('test "$base_ref" = "main"')
    expect(validateJob).toContain("release-please--*")
    expect(validateJob).toContain("EVENT_HEAD_REPO:")
    expect(validateJob).toContain("EVENT_HEAD_REF:")
    expect(validateJob).toContain("EVENT_BASE_REF:")
  })

  test("keeps all validation jobs read-only", () => {
    const validateJob = jobBlock(validate, "validate")
    expect(validate).toContain("permissions:\n  contents: read")
    expect(validateJob).toContain("permissions:\n      contents: read\n      pull-requests: read")
    for (const forbidden of [
      "checks: write",
      "actions: write",
      "contents: write",
      "pull-requests: write",
      "id-token",
      "security-events",
      "secrets.",
    ]) {
      expect(validateJob).not.toContain(forbidden)
    }
    expect(validate).not.toContain("\n  report:\n")
    expect(validate).not.toContain("check-runs")
    expect(validateJob).not.toContain("outputs:")
  })

  test("runs the same quality and subject gates as CI", () => {
    expect(validate).toContain("bun install --frozen-lockfile")
    expect(validate).toContain("bun run typecheck")
    expect(validate).toContain("bun test")
    expect(validate).toContain("bun run build")
    expect(validate).toContain("scripts/commit-subject-ok.sh")
    expect(validate).toContain('git log --format=\'%s\' "$BASE_SHA..$HEAD_SHA"')
  })

  test("sets up Node and pins npm before artifact acceptance", () => {
    const validateJob = jobBlock(validate, "validate")
    const node = validateJob.indexOf("actions/setup-node@v5")
    const npmPin = validateJob.indexOf("npm install -g npm@11.16.0")
    const acceptance = validateJob.indexOf("release-acceptance.ts --output-dir")
    expect(node).toBeGreaterThan(-1)
    expect(npmPin).toBeGreaterThan(node)
    expect(acceptance).toBeGreaterThan(npmPin)
    expect(validateJob).toContain("node-version: 24")
    expect(validateJob).toContain("package-manager-cache: false")
    expect(validateJob).toContain('test "$(npm --version)" = "11.16.0"')
    expect(validateJob).toContain("bun-version: 1.1.3")
    expect(validateJob).not.toContain("npm@latest")
  })

  test("accepts the checked-out head artifact after the CI gates with no bypass", () => {
    const validateJob = jobBlock(validate, "validate")
    const precheck = validateJob.indexOf("Validate PR identity through the GitHub API")
    const checkout = validateJob.indexOf("ref: ${{ github.event.pull_request.head.sha }}")
    const build = validateJob.indexOf("bun run build")
    const subjects = validateJob.indexOf("scripts/commit-subject-ok.sh")
    const acceptance = validateJob.indexOf(
      'bun scripts/release-acceptance.ts --output-dir "$ARTIFACT_DIR"',
    )
    expect(precheck).toBeGreaterThan(-1)
    expect(precheck).toBeLessThan(checkout)
    expect(checkout).toBeLessThan(acceptance)
    expect(build).toBeLessThan(acceptance)
    expect(subjects).toBeLessThan(acceptance)
    expect(validateJob).toContain("SCRATCH_ROOT: ${{ runner.temp }}")
    expect(validateJob).toContain("ARTIFACT_DIR: ${{ runner.temp }}/tokscope-release-pr")
    expect(validateJob).not.toContain("--allow-published")
    expect(validateJob).not.toContain("--verify-published")
    expect(validateJob).not.toContain("npm publish")
    expect(validateJob).not.toContain("continue-on-error")
  })

  test("keeps artifact acceptance free of registry credentials and OIDC", () => {
    const validateJob = jobBlock(validate, "validate")
    expect(validateJob).toContain("permissions:\n      contents: read\n      pull-requests: read")
    for (const forbidden of ["id-token", "NODE_AUTH_TOKEN", "NPM_TOKEN", "secrets.", "registry-url"]) {
      expect(validateJob).not.toContain(forbidden)
    }
  })

  test("uploads the full acceptance evidence directory even when acceptance fails", () => {
    const validateJob = jobBlock(validate, "validate")
    const acceptance = validateJob.indexOf('release-acceptance.ts --output-dir "$ARTIFACT_DIR"')
    const upload = validateJob.indexOf("actions/upload-artifact@v6")
    expect(upload).toBeGreaterThan(acceptance)
    const evidenceStep = validateJob.slice(
      validateJob.indexOf("Preserve acceptance evidence"),
      validateJob.indexOf("id: evidence"),
    )
    expect(evidenceStep).toContain("if: always()")
    expect(evidenceStep).toContain(
      "name: release-pr-evidence-${{ github.event.pull_request.number }}-${{ github.run_attempt }}",
    )
    expect(evidenceStep).toContain("path: ${{ runner.temp }}/tokscope-release-pr")
    expect(evidenceStep).toContain("if-no-files-found: warn")
    expect(evidenceStep).toContain("retention-days: 14")
    expect(evidenceStep).not.toContain("continue-on-error")
  })

  test("uploads evidence with the native Node 24 artifact action in every workflow", () => {
    for (const workflow of [release, validate]) {
      expect(workflow.match(/actions\/upload-artifact@\S+/g)).toEqual([
        "actions/upload-artifact@v6",
      ])
    }
  })

  test("preserves acceptance and audit failure summaries", () => {
    const validateJob = jobBlock(validate, "validate")
    const acceptance = validateJob.indexOf("release-acceptance.ts --output-dir")
    const freshness = validateJob.indexOf("Verify current PR head")
    const upload = validateJob.indexOf("Preserve acceptance evidence")
    const summary = validateJob.indexOf("Summarize validation and acceptance evidence")
    const gate = validateJob.indexOf("Require accepted evidence")
    expect(acceptance).toBeLessThan(freshness)
    expect(freshness).toBeLessThan(upload)
    expect(upload).toBeLessThan(summary)
    expect(summary).toBeLessThan(gate)

    const uploadStep = validateJob.slice(upload, summary)
    const summaryStep = validateJob.slice(summary, gate)
    const gateStep = validateJob.slice(gate)
    expect(uploadStep).toContain("if: always()")
    expect(summaryStep).toContain("if: always()")
    expect(gateStep).not.toContain("if: always()")
    for (const line of [
      "Prerequisites for head",
      "preflight",
      "no accepted artifact was preserved",
      "NOT a clean audit",
      "blocking high=",
      "audit=unverified",
      "Head freshness",
      "does not verify publication",
    ]) {
      expect(summaryStep).toContain(line)
    }
    expect(validateJob).not.toContain("continue-on-error")
    expect(validateJob).not.toContain("|| true")
  })

  test("checks live head before successful completion", () => {
    const validateJob = jobBlock(validate, "validate")
    const acceptance = validateJob.indexOf("release-acceptance.ts --output-dir")
    const freshness = validateJob.indexOf("name: Verify current PR head")
    const upload = validateJob.indexOf("Preserve acceptance evidence")
    const gate = validateJob.indexOf("Require accepted evidence")
    expect(freshness).toBeGreaterThan(acceptance)
    expect(freshness).toBeLessThan(upload)
    expect(upload).toBeLessThan(gate)

    const freshnessStep = validateJob.slice(freshness, upload)
    expect(freshnessStep).toContain("id: freshness")
    expect(freshnessStep).toContain("head-status.json")
    expect(freshnessStep).toContain("outcome=unverified")
    expect(freshnessStep).toContain("stale")
    expect(freshnessStep).toContain("closed")
    expect(validateJob).toContain("FRESHNESS: ${{ steps.freshness.outcome || 'not-run' }}")
  })

  test("requires exact evidence with fail-safe defaults before succeeding", () => {
    const validateJob = jobBlock(validate, "validate")
    const gate = validateJob.slice(validateJob.indexOf("Require accepted evidence"))
    expect(gate).toContain("ACCEPTANCE: ${{ steps.evidence.outputs.acceptance || 'not-run' }}")
    expect(gate).toContain("ARTIFACT: ${{ steps.evidence.outputs.artifact || 'unavailable' }}")
    expect(gate).toContain("AUDIT: ${{ steps.evidence.outputs.audit || 'unverified' }}")
    expect(gate).toContain("FRESHNESS: ${{ steps.freshness.outcome || 'not-run' }}")
    expect(gate).toContain("exception-applied|no-high-critical")
    expect(gate).toContain('"$acceptance" != "success"')
    expect(gate).toContain('"$artifact" != "accepted"')
    expect(gate).toContain('"$freshness" != "success"')
  })

  test("keeps acceptance, artifact, audit, and freshness outcomes distinct", () => {
    const validateJob = jobBlock(validate, "validate")
    expect(validateJob).toContain("ACCEPTANCE: ${{ steps.accept.outcome || 'not-run' }}")
    expect(validateJob).toContain("FRESHNESS: ${{ steps.freshness.outcome || 'not-run' }}")
    expect(validateJob).toContain("acceptance=$acceptance")
    expect(validateJob).toContain("artifact=$artifact")
    expect(validateJob).toContain("audit=$audit")
    expect(validateJob).toContain("$GITHUB_STEP_SUMMARY")
    expect(validateJob).not.toContain("publish verified")
    expect(validateJob).not.toContain("publication verified")
  })

  test("passes event values through env in validation steps", () => {
    expect(runBlocks(validate).length).toBeGreaterThan(0)
    for (const block of runBlocks(validate)) expect(block).not.toContain("${{")
  })

  test("documents evidence upload precisely", () => {
    const docs = read("docs/releasing.md")
    expect(docs).not.toContain("artifact, including on failure")
    expect(docs).toContain("whenever the acceptance step ran")
  })

  test("documents bot approval and the advisory native check", () => {
    const docs = read("docs/releasing.md")
    for (const line of [
      "Approve workflows to run",
      "`opened`, `synchronize`, and `reopened`",
      "Validate release PR / release-pr-validation",
      "not a required check",
      "ruleset `main protection` (ID `25836446`)",
      "no required status checks",
      "pre-fix",
    ]) {
      expect(docs).toContain(line)
    }
    expect(docs).not.toContain("does **not** trigger `pull_request` workflows")
    expect(docs).not.toContain("dispatches `.github/workflows/validate-release-pr.yml`")
    expect(docs).not.toContain("no branch protection at all")
    expect(docs).not.toContain("separate report job")
  })

  test("documents head-only freshness, diagnostic evidence, cache limits, and rollout", () => {
    const docs = read("docs/releasing.md")
    for (const line of [
      "head and PR state at that check only",
      "not the current base or merge result",
      "unsigned and diagnostic",
      "not a publishing attestation",
      "per pull request, not per head",
      "can read default-branch caches",
      "independent of the PR evidence, not of the code on the tag",
      "fix(ci): isolate release PR validation",
      "gh pr close 1 --repo mihaellenic/opencode-tokscope",
      "gh pr reopen 1 --repo mihaellenic/opencode-tokscope",
      "does not verify bot triggering",
      "Never revive the removed PR-code dispatch",
    ]) {
      expect(docs).toContain(line)
    }
  })

  test("documents the run summary separately from the evidence artifact", () => {
    const docs = read("docs/releasing.md")
    expect(docs).toContain("**Summary** tab and logs")
    expect(docs).toContain("human-readable acceptance, audit, and head-freshness summary")
    expect(docs).toContain("human-readable summary is not part of the artifact directory")
    expect(docs).toContain("`artifact.json`")
    expect(docs).toContain("`npm-audit-omit-dev.json`")
    expect(docs).toContain("`accepted-audit-exceptions.json`")
    expect(docs).toContain("`head-status.json`")
    expect(docs).not.toContain("raw audit, acceptance summary, and `head-status.json`")
  })

  test("records hosted release PR validation evidence and the gates still pending", () => {
    const docs = read("docs/releasing.md")
    expect(docs).not.toContain("No acceptance evidence exists for this remediation")
    expect(docs).not.toContain("alerts 1–7 still open")
    expect(docs).not.toContain("b0977006")
    expect(docs).not.toContain("disappears when the artifact expires")
    expect(docs).not.toContain("an owner-approved run of a bot-created PR event")
    for (const line of [
      "https://github.com/mihaellenic/opencode-tokscope/actions/runs/40237780191",
      "`github-actions[bot]`",
      "triggering actor is `mihaellenic`",
      "54e341e8cbc334d52efb5cf4a413dd2e25882484",
      "release-pr-evidence-1-2",
      "12615642893",
      "2026-11-08T21:57:43Z",
      "436c62daa569d636c08482f73fd58ab3f5a19a7b5b9fbb396a5e35a28e183132",
      "sha512-1cIpIGcvsF58cXeucktmbpTAv7lyvxRC2NZvy3J6Us7IULL4nQ8hF8Q1w34cyz9oBENIjKb6+yTqWFEbiy2eZw==",
      "outcome `current`",
      "NOT a clean audit",
      "seroval-ssr-unreachable-2026-11-07",
      "https://github.com/mihaellenic/opencode-tokscope/issues/2",
      "https://github.com/mihaellenic/opencode-tokscope/actions/runs/40237738234",
      "alerts 1–7 were `fixed`",
      "local copy persists until it is manually removed",
      "does not capture the original pending-approval screen",
      "release-pr-evidence-1-1",
      "registry-guard",
      "No publication, OIDC trusted-publishing smoke test",
    ]) {
      expect(docs).toContain(line)
    }
  })

  test("records hosted negative-path rejection evidence and its limits", () => {
    const docs = read("docs/releasing.md")
    expect(docs).not.toContain("controlled hosted negative-path runs (step 6)")
    expect(docs).not.toContain("not an end-to-end hosted negative-path observation")
    for (const line of [
      "Hosted negative-path rejection tests (2026-10-25)",
      "controlled test branches, not actual release forks or malicious-fork proof",
      "https://github.com/mihaellenic/opencode-tokscope/pull/8",
      "https://github.com/mihaellenic/opencode-tokscope/pull/9",
      "https://github.com/mihaellenic/opencode-tokscope/pull/10",
      "https://github.com/mihaellenic/opencode-tokscope/actions/runs/40239966134",
      "https://github.com/mihaellenic/opencode-tokscope/actions/runs/40239980624",
      "https://github.com/mihaellenic/opencode-tokscope/actions/runs/40240102996",
      "https://github.com/mihaellenic/opencode-tokscope/actions/runs/40240176037",
      "d78ad67cce8454d6969cd04d718b555e62b8d53d",
      "e2860aeff2f9885d901a3f07d307855c3963e139",
      "948ee7a0c99ad2da900f6e6aabf65979377e9543",
      "b66fb934393f277b46f8caf048e0e0db16f7656d",
      "controlled-negative/identity-mismatch",
      "failed before any checkout",
      "every production step is `skipped`",
      "`total_count: 0`",
      "version 0.1.0 is already published",
      "same already-published `0.1.0` registry guard",
      "`--allow-published` was not used",
      "outcome `stale`",
      "PR state `open`",
      "release-pr-evidence-10-1",
      "12616692086",
      "sha256:b0280956ef55884086f404cbcf898ce1edd068906965ba49a01eb6d424c857e4",
      "The net diff from `54e341e` to `b66fb93` is empty",
      "never authorized publication",
      "no Release workflow run",
      "were closed without merging",
      "remains an open draft",
      "No test injected a job-level `if` filter",
      "controlled diagnostic tests, not a security guarantee",
      "local ignored archives",
      "https://github.com/mihaellenic/opencode-tokscope/issues/11",
      "not fixed",
    ]) {
      expect(docs).toContain(line)
    }
  })

  test("attributes Node and npm to the controller environment, not the Bun commands", () => {
    const docs = read("docs/releasing.md")
    expect(docs).not.toContain("With Bun 1.4.4, Node 24.22.1, and npm 11.19.1")
    expect(docs).toContain("controller-environment.log")
    expect(docs).toContain("controller separately observed Node 24.22.1 and npm 11.19.1 in its own shell")
    expect(docs).toContain("not inputs to the Bun commands")
    expect(docs).toContain("npm `11.16.0`")
  })

  test("never executes PR code through pull_request_target", () => {
    for (const workflow of [ci, release, validate]) {
      expect(workflow).not.toContain("pull_request_target")
      expect(workflow).not.toContain("secrets.")
    }
  })
})
