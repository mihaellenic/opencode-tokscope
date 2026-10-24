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

/** Multi-line `run: |` bodies; event context must be passed through env, never interpolated into shell source. */
function runBlocks(source: string): string[] {
  const blocks: string[] = []
  let current: string[] | undefined
  let blockIndent = 0
  for (const line of source.split("\n")) {
    if (current === undefined) {
      const match = /^(\s*)run: \|\s*$/.exec(line)
      if (match) {
        current = []
        blockIndent = match[1]?.length ?? 0
      }
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

  test("pins the installed Bun version", () => {
    expect(ci).toContain("bun-version: 1.1.3")
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
    expect(release).not.toMatch(/npm publish\s*\n/)
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

  test("dispatches read-only validation for the release PR output", () => {
    expect(release).toContain("needs.release-please.outputs.pr")
    expect(release).toContain("gh workflow run validate-release-pr.yml")
    expect(release).toContain("gh run watch")
  })

  test("passes event and input values through env instead of shell interpolation", () => {
    expect(runBlocks(release).length).toBeGreaterThan(0)
    for (const block of runBlocks(release)) expect(block).not.toContain("${{")
  })
})

describe("release PR validation workflow", () => {
  test("is workflow_dispatch with required PR identity inputs", () => {
    expect(validate).toContain("workflow_dispatch:")
    expect(validate).toContain("        required: true")
    expect(validate).toContain("head_sha:")
    expect(validate).toContain("pr:")
  })

  test("validates the PR number and exact head SHA through the API", () => {
    expect(validate).toContain('gh api "repos/$GITHUB_REPOSITORY/pulls/$PR"')
    expect(validate).toContain('test "$actual_sha" = "$HEAD_SHA"')
    expect(validate).toContain('test "$state" = "open"')
    expect(validate).toContain('test "$base_ref" = "main"')
    expect(validate).toContain("ref: ${{ inputs.head_sha }}")
    expect(validate).toContain('test "$(git rev-parse HEAD)" = "$HEAD_SHA"')
  })

  test("runs the same quality and subject gates as CI", () => {
    expect(validate).toContain("bun install --frozen-lockfile")
    expect(validate).toContain("bun run typecheck")
    expect(validate).toContain("bun test")
    expect(validate).toContain("bun run build")
    expect(validate).toContain("scripts/commit-subject-ok.sh")
    expect(validate).toContain('git log --format=\'%s\' "$BASE_SHA..$HEAD_SHA"')
  })

  test("keeps validation read-only and scopes check publishing", () => {
    const validateJob = jobBlock(validate, "validate")
    const reportJob = jobBlock(validate, "report")
    expect(validateJob).toContain("permissions:\n      contents: read")
    expect(validateJob).not.toContain("contents: write")
    expect(validateJob).not.toContain("pull-requests: write")
    expect(reportJob).toContain("permissions:\n      checks: write")
    expect(reportJob).toContain("check-runs")
    expect(reportJob).toContain("needs.validate.result")
  })

  test("never executes PR code through pull_request_target", () => {
    for (const workflow of [ci, release, validate]) {
      expect(workflow).not.toContain("pull_request_target")
      expect(workflow).not.toContain("secrets.")
    }
  })
})
