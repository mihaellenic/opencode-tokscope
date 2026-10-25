# Releasing opencode-tokscope

## Automated release flow (current)

Release Please proposes each release as a `chore(main): release X.Y.Z` pull request containing the version bump, the generated `CHANGELOG.md`, and the manifest update. Merging that pull request into `main` **is** the owner's publish approval; for CI publishing it replaces the per-step approval gates 2–5 of the previous manual procedure. Review the release PR's version and changelog before merging, and merge it only when you intend that exact version to be published. Legal and metadata decisions are not automated: a license, copyright, or author change still needs a new owner decision.

Release Please creates and updates the release PR with the repository `GITHUB_TOKEN`. The resulting `pull_request` runs are created in an **approval-required** state for `opened`, `synchronize`, and `reopened` events. That includes every update to an existing release PR, not only its first creation: each bot push creates a new approval-required run, and an older green run or artifact is not current. No PAT or GitHub App secret is needed. A maintainer opens the PR's **Approve workflows to run** banner and approves the run.

Before approving, review the PR's current diff — especially `.github/workflows/` — and the current base and merge result. A `pull_request` run executes the workflow definition from the PR merge revision, so approval is not a defense against PR-controlled definitions: a writer who can change the workflow can change its permissions, trigger filter, and steps. Approval is an operational gate that is only as good as that review, not a security boundary.

The read-only `.github/workflows/validate-release-pr.yml` job runs only for same-repository heads on `release-please--` branches. It checks the live PR through the GitHub API (open, base `main`, same head repository and release ref, event head equal to the live head, valid base SHA), checks out the exact `github.event.pull_request.head.sha` — the PR head, not the PR-event merge commit in `github.sha` — and runs the same typecheck, test, build, and commit-subject checks as CI. It then runs the full pre-merge release preflight: the same `scripts/release-acceptance.ts` acceptance with `--output-dir` against a clean `git archive` export, covering tarball inspection, the scratch production-consumer install, and the section 4.1 consumer advisory audit with the same high/critical refusal and checked-exception handling as the release. The job has only `contents: read` and `pull-requests: read` — no `checks: write`, `actions: write`, OIDC, npm credential, or secret — and the publisher neither downloads nor trusts its artifact.

In the PR's checks, select **Validate release PR / release-pr-validation** for the exact head commit you intend to merge, confirm that head against the PR, and read the run's **Summary** tab and logs for the human-readable acceptance, audit, and head-freshness summary. Download the `release-pr-evidence-<PR>-<attempt>` artifact when you need the preserved tarball, `artifact.json`, the raw `npm-audit-omit-dev.json` (and its stderr file when present), the optional `accepted-audit-exceptions.json`, and `head-status.json`; the human-readable summary is not part of the artifact directory. Evidence is unsigned and diagnostic: it is produced by PR-controlled code, is not a publishing attestation, and is never read by the publisher. The freshness record's `current` outcome covers the head and PR state at that check only, not the current base or merge result. Review the current base/merge result and the current workflow diff yourself before approving or merging, because an advanced `main`, a retargeted PR, or a push after the final check can make an older green run misleading.

PR cache scope follows the pull request, not the head: caches from a `pull_request` run are scoped per pull request, not per head (the scope is the merge ref), a later run of the same PR can restore an earlier head's cache, and PR runs can read default-branch caches. The boundary preserved here is that PR code cannot write the default-branch cache scope; it is not a blanket read-only or per-head cache guarantee.

A high or critical advisory without an explicit, unexpired, exactly matching exception makes `release-pr-validation` red before merge, and the evidence upload preserves the raw audit and any `accepted-audit-exceptions.json` whenever the audit was reached. The check remains deliberately an advisory check, not a required check: it only runs for release PRs, so making it globally required would block ordinary PRs. The repository currently protects `main` with the active ruleset `main protection` (ID `25836446`): it requires code-owner review and an extra approval for changes not attributed to a code owner, has a required approval count of 0 and no required status checks, applies CodeQL thresholds `high_or_higher` and `errors`, prevents branch deletion and non-fast-forward pushes, and includes code-quality warnings. The specialized check is not among those required status checks, so an absent, pending, expired, or red run does not mechanically block a merge; inspect it yourself and do not treat absence or pending state as success. Verify the live ruleset rather than assuming this document's snapshot is current. The repository setting **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** must be enabled for Release Please to open the PR.

The merge triggers `.github/workflows/release.yml`. The publish job checks out the **exact release tag** created by Release Please (not floating `main`), sets up Node 24 and a pinned npm `11.16.0` before any npm operation, repeats the full acceptance with typecheck/tests/build and `scripts/release-acceptance.ts` with `--output-dir`, publishes only the tarball that acceptance preserved, and verifies that the registry version and `dist.integrity` match the accepted tarball metadata with a bounded retry for npm propagation. A green `release-pr-validation` preflight is not substituted for this postmerge run. This exact-tag acceptance is independent of the PR evidence, not of the code on the tag: the publisher runs the tag's own workflow and acceptance script, so review workflow and acceptance changes in the release PR before merging. Trusted publishing uses OIDC (`id-token: write`); no npm token, `NODE_AUTH_TOKEN`, `.npmrc`, or `registry-url` placeholder exists. The release-please job in the same run creates the tag and GitHub Release.

Trusted publisher setup is owner-run: npmjs.com → package `opencode-tokscope` → Settings → **Trusted Publisher**: provider GitHub, repository `mihaellenic/opencode-tokscope`, workflow filename **`release.yml`** (exact match). Do not add a stored npm token.

Artifact acceptance runs the section 4.1 advisory audit against the scratch production consumer, which has an npm lockfile, in both the PR preflight and the postmerge release. Each preserves `npm-audit-omit-dev.json` as evidence; the release workflow uploads its directory as a `release-evidence-<tag>` artifact whenever the acceptance step ran (its upload step uses `if: always()`), including when acceptance itself fails, and the PR preflight uploads its evidence to the validation run. **Every high or critical advisory blocks publication unless it is covered by the single checked exception below; in the PR preflight the same condition makes `release-pr-validation` red.** The 2026-10-24 seroval chain is covered only by an owner-authorized, expiry-bound, issue-linked exception in `scripts/audit-exception.ts`: the exact GHSA-p6vx-979v-rg4c and GHSA-jp82-f5mq-hwhp URLs, the current artifact manifest version for `opencode-tokscope`, the exact consumer-lockfile transitive versions (`@opencode/plugin@2.1.2`, `@opentui/solid@0.6.8`, `solid-js@1.9.12`, `seroval@1.5.6`), and the exact assessed chain, tracked by https://github.com/mihaellenic/opencode-tokscope/issues/2 and expiring at **2026-11-07T00:00:00Z (exclusive)**. When applied, it writes `accepted-audit-exceptions.json` beside the untouched raw audit. It is **not** a clean audit and does not waive any new advisory (including on the seroval entry itself), unknown package or path, version drift, cycle, unresolved `via` reference, or malformed report. Remove it or complete a fresh owner review before expiry.

Retry options:

- **Actions → re-run failed jobs** on the same run retains that run's Release Please outputs (`release_created`, `tag_name`). Use it when the failure happened before publication; the same acceptance and publish steps run again.
- If the original run cannot be retried, use **Actions → Release → Run workflow** with an existing release tag. Recovery requires a real, non-draft GitHub Release for that tag, validates the tag against `package.json` on the exact tag, and runs the same acceptance/publish pipeline. The input is passed to shell steps only through environment variables; arbitrary refs are never interpolated into commands. The duplicate-version guard stays strict, so recovery refuses to republish a version that is already on npm. If publication already succeeded, verify the registry integrity manually; do not bypass the guard. This recovery dispatch accepts only `release_tag`; it must never carry a PR number or head SHA, and it is not a validation path.
- After a release is confirmed, owner-run smoke tests and postpublication acceptance remain section 5 and section 7 work.

**Rolling out to the existing release PR.** Land this remediation on `main` with a releasable Conventional Commit such as `fix(ci): isolate release PR validation`; a non-releasable commit may not cause Release Please to update the open release PR. Then confirm that the bot updated the existing PR so its head contains the remediation, and that the bot `synchronize` event created an approval-required run. Do not infer that a validation run exists — check the PR's checks and workflow runs. If the bot does not update the PR, stop and inspect its release output before acting. With separate maintainer approval, a human may close and reopen the refreshed PR:

```bash
gh pr close 1 --repo mihaellenic/opencode-tokscope
gh pr reopen 1 --repo mihaellenic/opencode-tokscope
```

That produces a human `reopened` event, which normally runs immediately instead of waiting for bot approval. This fallback alone does not verify bot triggering; it only creates a run. Never revive the removed PR-code dispatch path. Resolve conflicts and obtain results for the current head before merging; deleted, closed, or superseded heads are not reusable evidence.

Release Please keeps the package pre-1.0: with `bump-minor-pre-major`, `feat` and breaking changes bump the minor version and `fix` bumps the patch version while the version is below 1.0.

The baseline is the published `opencode-tokscope@0.1.0` package and the existing `v0.1.0` tag (commit `e7a72f0`); `.release-please-manifest.json` starts at `0.1.0`. Release Please depends on this bootstrap state; do not delete, move, or reuse the tag, and do not reset the manifest.

The interactive smoke tests in section 5 and the postpublication named-resolution and `plugin add` checks in section 7 remain **owner-run verification after publication**. They are not prepublication gates in the automated flow, but a failure still stops distribution under the rule in section 7.

**Status (pre-fix evidence):** the hosted runs below describe the removed dispatched design, not the current `pull_request`-triggered validator; they remain historical records only. CI [run 40179092586](https://github.com/mihaellenic/opencode-tokscope/actions/runs/40179092586) and release [run 40179092606](https://github.com/mihaellenic/opencode-tokscope/actions/runs/40179092606) succeeded, and the dispatched `release-pr-validation` preflight [run 40179119951](https://github.com/mihaellenic/opencode-tokscope/actions/runs/40179119951) succeeded on release PR #1 head `fe363f9bfdf9a9f256029cc18be88451f2434ba5`. Its summary recorded a raw consumer audit with five critical entries, the scoped exception applied, and **NOT a clean audit**, and uploaded artifact `release-pr-evidence-1-1`. OIDC npm publish has **not** been exercised: the merge-time publish, OIDC trusted-publishing configuration and permission, postmerge acceptance, and published-integrity verification remain unverified. The PR-native validator and its approval-required flow have not been observed in a hosted run, and this document does not claim that the pre-fix CodeQL alerts are closed or that publication is verified; record a real run before making those claims. A green preflight proves neither publication nor future dependency resolution; do not describe those as hosted-runtime verified until a real publish run is recorded.

### Local remediation evidence and pending hosted verification (2026-10-25)

The PR-scoped validation, the removal of the PR dispatch path, and the malformed-response handling exist as local commits on `fix/release-pr-cache-isolation` only: `f84d8e9` (`fix(ci): isolate release validation in pull request scope`), `a327799` (`fix(ci): keep unverified head snapshot on malformed responses`), `0a10bf2` (`refactor(ci): remove release PR dispatch and document approvals`), and `955084a` (`docs: distinguish run summary from evidence artifact`). A later test-and-docs-only final-review fix adds two documentation regression tests to `test/workflows.test.ts` and changes no workflow, script, or product behavior. That branch is unpublished with no upstream, so no hosted commit or workflow-run URL exists for these commits; do not cite one. `bun test` (248 pass, 0 fail, 776 expect calls, 16 files under the local Bun 1.1.3 used for this final-review verification), `bun run typecheck`, `bun run build`, and `git diff --check` from `998ca9c` to this branch's head all exited 0 locally; the retained `controller-typecheck.log` and `controller-build.log` record exit 0 for the same two commands, and `controller-environment.log` records the controller's separately observed Bun 1.4.4. The controller separately observed Node 24.22.1 and npm 11.19.1 in its own shell; those are separately observed environment facts, not inputs to the Bun commands above and not the workflows' pins (`release.yml` sets up Node 24 and pins npm `11.16.0` for its own npm operations). This coverage is fixture-level and local: `test/release-pr-isolation.test.ts` and `test/release-acceptance.test.ts` exercise PR identity and head verification, stale/closed/unverified outcomes, the summary distinctions, `registry-guard`, artifact metadata and integrity, audit fail-closed behavior, the scoped exception, and published-artifact comparison against fixtures, while `test/workflows.test.ts` checks workflow structure and documentation text. None of it observes a hosted approval-required run, the PR-event ref and API/checkout head mapping, evidence upload or retention, or a CodeQL analysis.

A full artifact acceptance was attempted once, on `955084a`, with the approved `SCRATCH_ROOT` and a fresh `--output-dir`. It exited 1 at `registry-guard` immediately after `preflight`, because `package.json` still names the already-published, immutable `opencode-tokscope@0.1.0`. The refusal was preserved and `--allow-published` was not used, so no tarball, `artifact.json`, or raw consumer audit was written for that attempt. **No acceptance evidence exists for this remediation, and no `0.2.0` acceptance exists under the PR-scoped validator.** The only passing artifact is the historical pre-fix `0.1.1` dispatched run recorded above (`release-pr-evidence-1-1`: tarball, `artifact.json`, raw five-critical audit, and `accepted-audit-exceptions.json` under the checked exception); it is not current evidence, does not cover these commits, and was never a clean audit. That exit is the duplicate-version guard working as designed, not an acceptance result, and it must not be recorded as one.

As inspected on 2026-10-25, Release Please PR #1 proposes the unpublished `0.2.0` at head `b0977006`, which does not contain these commits; nothing on that head is current evidence for this remediation. After this branch lands with a releasable commit, that PR must be refreshed by the normal Release Please update and the maintainer must approve or reject its resulting approval-required run on the refreshed head, or use the separately approved human close/reopen fallback; a hand-edited version, a local revision, or a local acceptance run must never stand in for that hosted result. No push, pull request, hosted workflow run, or CodeQL analysis has been performed for this remediation, and the read-only 2026-10-25 alert inspection recorded alerts 1–7 still open at high severity on `main` (actions/cache-poisoning and poisonable-step); an alert counts as closed only when analysis of the merged remediation revision on `main` reports it `fixed`. Until a current-head `release-pr-validation` run and that CodeQL closure are recorded, publication of `0.2.0` stays blocked, and the tracking issue https://github.com/mihaellenic/opencode-tokscope/issues/5 stays open. The publisher has no alert-status gate, so the maintainer records and approves this evidence before merging the release PR.

For a fresh clone, run `bun install` and `bun run setup` before making release changes. `bun run setup` registers the shared `githooks/commit-msg` Conventional Commit hook; CI runs the same subject script, so bypassing the local hook does not bypass CI.

The manual procedure below is the fallback when CI publishing is unavailable. Never ask for or paste passwords, one-time codes, or npm tokens into chat; the automated flow needs no npm credentials from the owner. No public-source hosting permission is assumed, and the pipeline never pushes source code automatically.

## Manual fallback procedure

> **Dry runs do not publish.** `npm pack`, `npm pack --dry-run`, and `npm publish --dry-run` create or inspect local artifacts only. They are not evidence that a version exists on npm, and a successful dry run is not approval to publish.

## Running the checks

Run every command in this document in **one persistent Bash shell** started from the repository root. Do not paste snippets into separate shells: `SCRATCH`, `SOURCE`, and `INSTALLED` carry forward between sections.

Set the environment's approved temporary root explicitly. Do not infer `TMPDIR` and do not fall back to `/tmp`:

```bash
set -euo pipefail
export SCRATCH_ROOT="${SCRATCH_ROOT:?Set SCRATCH_ROOT to the approved temporary directory}"
test -d "$SCRATCH_ROOT"
```

## Version and tag consistency

The manifest version, tarball name, registry version, and release tag must agree. For the first release they are `0.1.0`, `opencode-tokscope-0.1.0.tgz`, and `v0.1.0`.

```bash
node -p 'require("./package.json").version'   # must print 0.1.0
```

Use a new npm version for every later release. Never attempt to overwrite or republish `0.1.0`. Tags are created only after publication is approved and verified, on the source commit that produced the accepted artifact:

```bash
test "$(node -p 'require("./package.json").version')" = "0.1.0"
RELEASE_COMMIT="$(git rev-parse HEAD)"   # confirm this is the accepted source commit
git tag -a v0.1.0 "$RELEASE_COMMIT" -m "opencode-tokscope 0.1.0"
```

Do not move or reuse a release tag. Do not push the tag without a separate approval and a confirmed remote.

## 1. Export a clean source tree

Use a `git archive` export, not a worktree, so generated `dist/`, `node_modules/`, and untracked internal material cannot leak into acceptance. Run from the repository root with the intended release commit checked out and a clean tracked tree.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
test -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)"   # tracked work must be clean; git archive omits untracked files anyway

SCRATCH="$(mktemp -d "$SCRATCH_ROOT/tokscope-release.XXXXXX")"
SOURCE="$SCRATCH/source"
mkdir -p "$SOURCE"

git -C "$REPO_ROOT" archive --format=tar HEAD | tar -x -C "$SOURCE"
cd "$SOURCE"

test ! -e dist
test -f LICENSE
test -f README.md
bun install --frozen-lockfile
bun test
bun run typecheck

echo "SCRATCH=$SCRATCH"
echo "SOURCE=$SOURCE"
```

Use the environment's approved temporary root. Keep `$SCRATCH` for the rest of the run; all later commands depend on it. The export must not contain `dist/` before the pack step. If a local checkout carries internal working documents, the npm allowlist excludes them from the artifact; this public repository deliberately avoids tracking them.

## 2. Pack once for acceptance

Pack from the exported tree. Only this artifact may be published; do not rebuild between acceptance and publication.

```bash
cd "$SOURCE"
npm pack --json --pack-destination "$SCRATCH" | sed -n '/^\[/,$p' > "$SCRATCH/pack.json"

node -e '
const fs = require("node:fs")
const [packed] = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
if (packed.filename !== "opencode-tokscope-0.1.0.tgz") {
  throw new Error(`unexpected artifact: ${packed.filename}`)
}
console.log(JSON.stringify({ filename: packed.filename, integrity: packed.integrity, shasum: packed.shasum }, null, 2))
' "$SCRATCH/pack.json"

shasum -a 256 "$SCRATCH/opencode-tokscope-0.1.0.tgz" | tee "$SCRATCH/artifact.sha256"
```

Expect exactly one tarball and a successful `prepack` build from a missing `dist/`. The `built dist/tui.js` line belongs to `prepack` and appears before the JSON; the `sed` above isolates the JSON array. Record both the npm integrity and the SHA-256 hash.

## 3. Inspect and extract the tarball

```bash
tar -tzf "$SCRATCH/opencode-tokscope-0.1.0.tgz" | tee "$SCRATCH/artifact-files.txt"

UNEXPECTED="$(tar -tzf "$SCRATCH/opencode-tokscope-0.1.0.tgz" \
  | grep -Ev '^package/(package\.json|README\.md|LICENSE|tui\.js|dist/tui\.js)$' || true)"
test -z "$UNEXPECTED"   # any other path is a failure

mkdir -p "$SCRATCH/unpacked"
tar -xzf "$SCRATCH/opencode-tokscope-0.1.0.tgz" -C "$SCRATCH/unpacked"

test -f "$SCRATCH/unpacked/package/dist/tui.js"
test -f "$SCRATCH/unpacked/package/tui.js"

node -e '
const p = require(process.argv[1])
if (p.name !== "opencode-tokscope" || p.version !== "0.1.0") throw new Error("wrong package identity")
if (p.license !== "MIT") throw new Error("license is not MIT")
if (p.publishConfig?.access !== "public") throw new Error("publish access is not public")
if (p.exports?.["./tui"] !== "./dist/tui.js") throw new Error("TUI export target changed")
for (const hook of ["preinstall", "install", "postinstall"]) {
  if (p.scripts?.[hook]) throw new Error(`consumer lifecycle hook present: ${hook}`)
}
console.log("manifest checks passed")
' "$SCRATCH/unpacked/package/package.json"

node -e '
const fs = require("node:fs")
const code = fs.readFileSync(process.argv[1], "utf8")
for (const specifier of ["@opencode/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js"]) {
  if (!code.includes(`from "${specifier}"`)) throw new Error(`host runtime is not external: ${specifier}`)
}
console.log("host runtime imports remain external")
' "$SCRATCH/unpacked/package/dist/tui.js"

if grep -RInE --binary-files=without-match 'task-[0-9]+-report|BEGIN [A-Z ]*PRIVATE KEY' "$SCRATCH/unpacked/package"; then
  echo "internal or secret material found in artifact" >&2
  exit 1
fi

if grep -RInF --binary-files=without-match "$SOURCE" "$SCRATCH/unpacked/package"; then
  echo "absolute source path found in artifact" >&2
  exit 1
fi
```

Accept only `package/package.json`, `package/README.md`, `package/LICENSE`, `package/tui.js`, and `package/dist/tui.js`. Reject missing export targets, internal reports or plans, credentials, source maps pointing at the checkout, absolute checkout paths, and any undeclared runtime import. If a test or inspection fails, stop: do not publish a rebuilt or partially accepted artifact.

## 4. Install the artifact as a consumer

Install outside the repository, omitting development dependencies and lifecycle scripts. The plugin is prebuilt; the consumer must not need Bun or a build step.

```bash
mkdir -p "$SCRATCH/consumer"
npm install \
  --prefix "$SCRATCH/consumer" \
  --omit=dev \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  "$SCRATCH/opencode-tokscope-0.1.0.tgz"

INSTALLED="$SCRATCH/consumer/node_modules/opencode-tokscope"
test -f "$INSTALLED/dist/tui.js"
test -f "$INSTALLED/tui.js"
node -p 'require(process.argv[1]).version' "$INSTALLED/package.json"
npm explain --prefix "$SCRATCH/consumer" opencode-tokscope
```

Record whether dependency resolution succeeded and confirm no install script ran. The smoke-test target is `$INSTALLED`, not this checkout and not an `npm link`. If npm reports missing peers or a failed dependency, stop and investigate rather than adding local paths.

Peer resolution is part of acceptance. If npm reports `ERESOLVE`, do not add `--legacy-peer-deps` or `--force` to make the check pass; that hides a broken consumer install. Correct the peer contract in a separate owner-approved packaging change, rebuild, and re-run artifact acceptance.

### 4.1 Dependency and advisory acceptance

Run the advisory audit against the scratch production consumer, never the repository. Do not add a repository `package-lock.json`, upgrade npm/Bun, or change peers/engines to get a green result. The installed Bun 1.1.3 has no native audit subcommand, so use npm from the consumer.

A nonzero audit exit is expected when advisories exist. Handle it explicitly so `set -e` does not hide it and the result is not mistaken for success:

```bash
cd "$SCRATCH/consumer"
set +e
npm audit --omit=dev --json > "$SCRATCH/npm-audit-omit-dev.json" 2> "$SCRATCH/npm-audit-omit-dev.stderr.txt"
AUDIT_EXIT=$?
set -e

printf 'npm audit exit: %s\n' "$AUDIT_EXIT"
if [ "$AUDIT_EXIT" -eq 0 ]; then
  echo "npm audit reported no known vulnerabilities"
else
  echo "npm audit exit $AUDIT_EXIT: capture and triage this result before release" >&2
fi

node -e '
const fs = require("node:fs")
const audit = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
console.log("severity buckets:", JSON.stringify(audit.metadata?.vulnerabilities ?? {}))
for (const [name, entry] of Object.entries(audit.vulnerabilities ?? {})) {
  const via = (entry.via ?? []).map((item) => typeof item === "string" ? item : item.title).join("; ")
  console.log(`${entry.severity}: ${name} via ${via}`)
}
' "$SCRATCH/npm-audit-omit-dev.json"
```

The 2026-10-24 baseline audit exited 1 with five critical entries in npm's per-package buckets. They are one transitive chain, not five unrelated vulnerabilities: `opencode-tokscope@0.1.0 → @opencode/plugin@2.1.2 → @opentui/solid@0.6.8 → solid-js@1.9.12 → seroval@1.5.6`. The underlying advisories are GHSA-p6vx-979v-rg4c (critical, `fromJSON` thenable assimilation) and GHSA-jp82-f5mq-hwhp (high, unchecked TypedArray length). npm may aggregate or dedupe the same root cause differently between runs; record the actual buckets and chain, not the count alone. `@opentui/solid` currently peer-pins solid-js exactly `1.9.12`, so the patched seroval path requires an upstream OpenTUI change; there is no local manifest fix that clears the tree without overriding peers or engine checks.

A scoped reachability assessment found no affected SSR/`fromJSON` deserialization path in the supported host-bound plugin: `seroval` is imported only by Solid's SSR server entry, the shipped `dist/tui.js` imports only the four host externals, and neither the plugin dist nor the `@opentui/solid`, `@opentui/core`, and `@opencode/plugin` dist trees load `solid-js/web`, `seroval`, or `fromJSON` for untrusted data. This is a scoped assessment, **not** a clean audit and not a blanket safety promise. Standalone use of the npm-installed dependency tree is unsupported and may still surface these advisories.

Re-run the consumer audit and re-evaluate reachability **before publication and no later than 2026-11-07, whichever comes first**. Any reachable or untriaged high/critical finding blocks release. An existing unreachable finding may be accepted only with its scope, rationale, and review date recorded in the release evidence and, for automation, an owner-authorized checked exception with a fixed expiry; it must never be hidden or described as a clean audit.

Automated acceptance runs this audit itself against the scratch production consumer and fails closed on malformed output, network/auth errors, cycles, unresolved `via` references, unknown packages or paths, and **every** high/critical entry. The only automated allowance is the checked exception in `scripts/audit-exception.ts`. It is not package-level or severity-wide: it accepts only the two exact advisory URLs, the exact advisory names and severities, the current artifact manifest version for the root package, the exact resolved transitive versions read from the consumer `package-lock.json` at acceptance time, and the exact assessed `opencode-tokscope → @opencode/plugin / @opentui/solid → solid-js → seroval` edges. Any new advisory on the same seroval entry, any additional package or edge, any dependency version drift, a mismatch between the installed and manifest root versions, a cycle, an unresolved reference, or malformed data refuses release. An ordinary release-please root version bump therefore does not revise the exception; the vulnerable and transitive component pins stay exact. The exception is explicitly linked to https://github.com/mihaellenic/opencode-tokscope/issues/2; an empty or different tracker URL is invalid. It expires at `2026-11-07T00:00:00Z`; acceptance at or after that instant refuses release even when the advisories still match, and an invalid or missing exception configuration also refuses release. A report with no high/critical entries passes without consulting the exception.

When applied, acceptance preserves the raw `npm-audit-omit-dev.json` unchanged and writes a separate `accepted-audit-exceptions.json` containing the exception id, exact advisories, blocking entries, resolved versions, owner authorization, rationale, expiry, and an explicit residual-risk warning. Console output and the acceptance summary must say that the scoped exception was applied and must **not** claim a clean audit.

EBADENGINE and deprecation warnings are separate from advisories and are not audit findings. For example, peer auto-resolution may install `@opentui/core@0.6.8`, whose engine metadata targets Node `>=26.4.0` and Bun `>=1.3.14`, while the external npm process used for packing may be older. The supported runtime is OpenCode's bundled host, not that external Node process. Record the warnings; do not override engine checks to silence them.

## 5. Smoke-test the installed artifact in OpenCode V2

These are interactive checks. Launch the TUI from the persistent release shell (or an equivalent session with the same exported variables). Do not overwrite, relocate, or disable the owner's `~/.config/opencode/cli.json`, plugin symlink, or running service.

Record the exact host before testing:

```bash
opencode --version
```

### 5.1 Empty history: isolated private server

Use scratch config, data, state, cache, database, and working directories so the owner's configuration and auto-discovered plugins cannot load. The explicit installed-package path is still supplied through the inline CLI override.

```bash
SMOKE_EMPTY="$SCRATCH/smoke-empty"
mkdir -p \
  "$SMOKE_EMPTY/config/opencode" \
  "$SMOKE_EMPTY/data" \
  "$SMOKE_EMPTY/state" \
  "$SMOKE_EMPTY/cache" \
  "$SMOKE_EMPTY/db" \
  "$SMOKE_EMPTY/work"

export XDG_CONFIG_HOME="$SMOKE_EMPTY/config"
export XDG_DATA_HOME="$SMOKE_EMPTY/data"
export XDG_STATE_HOME="$SMOKE_EMPTY/state"
export XDG_CACHE_HOME="$SMOKE_EMPTY/cache"
export OPENCODE_DB="$SMOKE_EMPTY/db/empty.db"
export OPENCODE_CLI_CONFIG_CONTENT="$(node -e '
console.log(JSON.stringify({ plugins: [process.argv[1]] }))
' "$INSTALLED")"

cd "$SMOKE_EMPTY/work"
opencode --standalone
```

Confirm all of the following in that isolated process:

- Exactly one Tokscope command appears.
- `/tokscope` opens the page, and `esc` returns.
- The session sidebar renders and clicking it opens the page.
- Empty history shows the intended empty state, not a crash or fake zeroes.
- There is no duplicate Tokscope copy, missing-module error, duplicate-runtime symptom, or `No renderer found` failure.

Quit the TUI before continuing.

### 5.2 Available real history: shared service

This check reads the running shared service's history without changing it. Keep the CLI config isolated in scratch space so the owner's plugin symlink/config is not auto-discovered, but use the default data and state locations so the client connects to the existing shared service instead of starting another one. Do not stop, restart, or reconfigure that service.

```bash
SMOKE_SHARED="$SCRATCH/smoke-shared"
mkdir -p "$SMOKE_SHARED/config/opencode" "$SMOKE_SHARED/work"

export XDG_CONFIG_HOME="$SMOKE_SHARED/config"
unset XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME OPENCODE_DB OPENCODE_CLI_CONFIG_CONTENT
export OPENCODE_CLI_CONFIG_CONTENT="$(node -e '
console.log(JSON.stringify({ plugins: [process.argv[1]] }))
' "$INSTALLED")"

cd "$SMOKE_SHARED/work"
opencode
```

Repeat the command/page/sidebar checks and confirm that available real history displays. If the shared service or suitable real history is unavailable, this required check is unverified and publication is blocked.

Quit the TUI before continuing.

### 5.3 Genuine auto-discovery through a scratch plugin directory

This check does not use the configured `plugins` array or inline override. It discovers the package through a scratch `plugins` directory and the root `tui.js` re-export. The export already has `dist/` from the pack step.

```bash
SMOKE_DISCOVERY="$SCRATCH/smoke-discovery"
mkdir -p \
  "$SMOKE_DISCOVERY/config/opencode/plugins" \
  "$SMOKE_DISCOVERY/data" \
  "$SMOKE_DISCOVERY/state" \
  "$SMOKE_DISCOVERY/cache" \
  "$SMOKE_DISCOVERY/db" \
  "$SMOKE_DISCOVERY/work"

export XDG_CONFIG_HOME="$SMOKE_DISCOVERY/config"
export XDG_DATA_HOME="$SMOKE_DISCOVERY/data"
export XDG_STATE_HOME="$SMOKE_DISCOVERY/state"
export XDG_CACHE_HOME="$SMOKE_DISCOVERY/cache"
export OPENCODE_DB="$SMOKE_DISCOVERY/db/empty.db"
unset OPENCODE_CLI_CONFIG_CONTENT

ln -sfn "$SOURCE" "$SMOKE_DISCOVERY/config/opencode/plugins/opencode-tokscope"
cd "$SMOKE_DISCOVERY/work"
opencode --standalone
```

Confirm `/tokscope` opens through the root `tui.js` re-export and that only one Tokscope copy is loaded. To exercise auto-discovery of the **installed artifact** rather than the source export, link `$INSTALLED` instead and repeat.

### 5.4 Residual risk: prepublication checks cannot prove named npm resolution or `plugin add` acceptance

Every prepublication check above supplies an explicit path: either `OPENCODE_CLI_CONFIG_CONTENT` or a scratch plugin directory. Those checks prove the artifact, runtime, and isolation behavior, but they do **not** exercise resolving the package by its not-yet-published registry name, and they do **not** exercise the `opencode plugin add` install path. The official V2 CLI supports named TUI-only packages, and its `plugin add` command classifies a TUI-only package and records it in `cli.json`; prepublication path checks still cannot prove that either behavior works with the published artifact.

Do not infer publication approval from these checks, and do not stand up or publish to a local registry to simulate the public name. Named resolution and `plugin add` acceptance must both be tested immediately after publication as described in section 7.

Compatibility claims are limited to recorded evidence. OpenCode **2.1.2** is the development API baseline and the historically tested host; the installed host may be a newer 2.x release such as 2.1.4. Record the exact version used for acceptance, but do not add a new README compatibility claim until that run is recorded. If the host cannot be isolated safely, stop; do not publish until the required checks have actually passed.

## 6. Publication prerequisites

All of these must be true before the publish command is even considered:

- The owner has approved the exact artifact hash and this public release.
- `package.json` still says `opencode-tokscope@0.1.0`; no rebuild has changed the accepted bytes.
- The version is unpublished and the package name is available to the intended account.
- The owner has authenticated interactively with publishing 2FA.
- The publication target is public and unscoped, with `publishConfig.access = "public"`.
- The artifact review above passed, and all required prepublication runtime checks passed: path-isolated empty history, real history, and genuine auto-discovery. Pending or failed checks block publication; there is no pending-check bypass.
- The consumer-scoped advisory audit was re-run before publication or by 2026-11-07, whichever comes first, and reachability was re-evaluated. Any reachable or untriaged high/critical finding blocks release; an unreachable finding is accepted only with recorded scope, rationale, and review date and, for automation, the unexpired checked seroval exception with exactly matching advisory URLs, current artifact root version, pinned transitive versions, and assessed paths.
- The residual risk is understood: prepublication path checks cannot prove named npm resolution. Postpublication named-resolution and `plugin add` acceptance in section 7 are mandatory, and failure stops distribution.
- No public source URL is required. Do not invent one; add repository/homepage metadata only if hosting is separately approved.

```bash
npm login   # owner-only, interactive, with publishing 2FA
npm whoami

if npm view opencode-tokscope@0.1.0 version >/dev/null 2>&1; then
  echo "opencode-tokscope@0.1.0 is already published; stop and agree on a new version" >&2
  exit 1
fi
```

Do not proceed if `npm whoami` shows an unexpected account or the version check finds an existing `0.1.0`.

## 7. Publish the accepted tarball

Only after the owner explicitly approves publication of the exact artifact:

```bash
npm publish "$SCRATCH/opencode-tokscope-0.1.0.tgz" --access public
```

Publish the accepted tarball itself. Do not run `npm publish` from the checkout, because that can produce different bytes. Then compare the registry integrity with the accepted pack metadata:

```bash
npm view opencode-tokscope@0.1.0 version dist.integrity
```

The reported version must be `0.1.0` and `dist.integrity` must equal the integrity recorded in `$SCRATCH/pack.json`.

### Mandatory postpublication named-resolution acceptance

Prepublication checks used explicit paths and therefore cannot prove that the published name resolves. Immediately after publication, test **both** the versioned and unversioned named configuration in isolated scratch environments. No local path or symlink may satisfy these runs.

```bash
postpub_check() {
  local label="$1"
  local plugin="$2"
  local dir="$SCRATCH/postpub-$label"

  mkdir -p \
    "$dir/config/opencode" \
    "$dir/data" \
    "$dir/state" \
    "$dir/cache" \
    "$dir/db" \
    "$dir/work"

  node -e '
const fs = require("node:fs")
const dir = process.argv[1]
const plugin = process.argv[2]
fs.writeFileSync(`${dir}/cli.json`, JSON.stringify({ plugins: [plugin] }, null, 2) + "\n")
' "$dir/config/opencode" "$plugin"

  export XDG_CONFIG_HOME="$dir/config"
  export XDG_DATA_HOME="$dir/data"
  export XDG_STATE_HOME="$dir/state"
  export XDG_CACHE_HOME="$dir/cache"
  export OPENCODE_DB="$dir/db/empty.db"
  unset OPENCODE_CLI_CONFIG_CONTENT

  ( cd "$dir/work" && opencode --standalone )
}

postpub_check pinned "opencode-tokscope@0.1.0"
postpub_check latest "opencode-tokscope"
```

For each run, confirm exactly one Tokscope command, `/tokscope` navigation and Escape return, sidebar rendering and click navigation, the empty-history state, and no missing-module, duplicate-runtime, or `No renderer found` failure. The unversioned run must resolve to the newly published version and must not be satisfied by a local package, path, or symlink. The pre-existing-`cli.json` state check below belongs to the `plugin add` acceptance only: `postpub_check` writes its fixture file directly and is not an exercise in preserving existing keys.

### `plugin add` acceptance

This check exercises the documented one-command install path end to end: the CLI resolves the published package by name, installs it, classifies it as a TUI plugin, and records it in `cli.json`. Like the named-resolution runs, it must be satisfied only by the published registry package, never by a local path or symlink, and it runs with scratch-isolated configuration so the owner's own `cli.json` is untouched.

```bash
plugin_add_check() {
  local dir="$SCRATCH/plugin-add"

  mkdir -p \
    "$dir/config/opencode" \
    "$dir/data" \
    "$dir/state" \
    "$dir/cache" \
    "$dir/db" \
    "$dir/work"

  printf '{\n  "$schema": "https://opencode.ai/v2/cli.json",\n  "other": true\n}\n' > "$dir/config/opencode/cli.json"

  export XDG_CONFIG_HOME="$dir/config"
  export XDG_DATA_HOME="$dir/data"
  export XDG_STATE_HOME="$dir/state"
  export XDG_CACHE_HOME="$dir/cache"
  export OPENCODE_DB="$dir/db/plugin-add.db"
  unset OPENCODE_CLI_CONFIG_CONTENT

  ( cd "$dir/work" && opencode plugin add opencode-tokscope )

  node -e '
const cfg = require(process.argv[1] + "/config/opencode/cli.json")
if (cfg.other !== true) throw new Error("pre-existing `other` key did not survive: " + JSON.stringify(cfg))
if (!Array.isArray(cfg.plugins) || !cfg.plugins.includes("opencode-tokscope")) {
  throw new Error("plugin entry missing or malformed: " + JSON.stringify(cfg))
}
console.log("plugin add cli.json acceptance passed (parse-based)")
' "$dir"

  ( cd "$dir/work" && opencode --standalone )
}

plugin_add_check
```

Confirm all of the following: the `opencode plugin add` command announces success against a `cli.json` path under `$XDG_CONFIG_HOME`; the file now contains `opencode-tokscope` and still contains the pre-existing `"other": true` key; the follow-up scratch TUI launch shows exactly one Tokscope command and page with no missing-module, duplicate-runtime, or `No renderer found` failure. If `plugin add` writes to a different file, fails, or corrupts existing keys, that is an acceptance failure: record the exact output and follow the stop-distribution rule below.

If either named configuration or the `plugin add` acceptance fails, `0.1.0` is immutable: stop distribution immediately, do not unpublish or overwrite `0.1.0`, fix the package/name/resolution contract, and repeat full acceptance under a new version such as `0.1.1`.

## 8. Record release evidence

Report to the owner, without checking private session data into the repository:

- source commit and package version;
- exact `opencode --version` used for the smoke test;
- `bun test` and `bun run typecheck` results from the clean export;
- tarball filename, file list, SHA-256, and npm integrity; the accepted `artifact.json` (path/version/integrity) and the `release-evidence-<tag>` workflow artifact;
- consumer install result;
- consumer-scoped `npm audit` exit code and raw JSON, severity buckets, advisory chain, reachability decision, scope/rationale, and review date; when the checked exception applies, also the separate `accepted-audit-exceptions.json` with its id, tracking issue URL, exact advisories, pinned versions, expiry, owner authorization, and residual-risk warning. Record EBADENGINE/deprecation warnings separately from advisories;
- each prepublication smoke-test outcome: isolated empty history, real history, and genuine auto-discovery. Pending or failed checks block publication; they are not accepted as pending;
- postpublication named-resolution results for both `opencode-tokscope@0.1.0` and `opencode-tokscope`, and the `plugin add` acceptance result, including any stop-distribution decision;
- publication result and registry integrity comparison, if publication was approved.

## npm files review versus public source hosting

Reviewing the npm tarball is not a review of the repository. The tarball contains only the allowlisted runtime files plus README, LICENSE, and `package.json`. Public source hosting (or any repository whose history contains local-only internal plans, reports, or private data) exposes the full working tree, Git history, author metadata, and anything ever committed.

Before any public repository push or visibility change, separately review the complete tree and history for credentials, private session or project data, internal reports, large generated files, and unwanted personal information. Obtain explicit approval for that review and for the hosting action. Adding a repository URL, homepage, or bugs URL to `package.json` is a later metadata change, not part of the first publication unless hosting is approved first.

## Deferred follow-ups

Do not add these during the first manual release:

- ~~CI publishing, including npm trusted publishing/OIDC and provenance.~~ Delivered 2026-10-25 via Release Please + npm trusted publishing; see **Automated release flow** above.
- Screenshots or a demo with representative, sanitized data.
- Ecosystem and community plugin listings.

They follow only after the first manual release is verified.
