# Releasing opencode-tokscope

Releases are automated with Release Please and npm trusted publishing.
**Merging the release PR into `main` approves publication of that version.**
Do not merge it just to update the changelog.

## Setup

- Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**.
- On npm, configure the package's **Trusted Publisher** for GitHub repository
  `mihaellenic/opencode-tokscope` and workflow filename **`release.yml`**.
  Publishing uses OIDC; do not add a stored npm token or `NODE_AUTH_TOKEN`.
- For local development, run `bun install` and `bun run setup` to install the
  Conventional Commit hook. CI also validates commit subjects.

Workflow tool versions are defined in [release.yml](../.github/workflows/release.yml)
and [validate-release-pr.yml](../.github/workflows/validate-release-pr.yml).
Use those versions when reproducing a failure locally.

## 1. Prepare and review the release PR

On pushes to `main`, Release Please creates or updates a `chore(main): release X.Y.Z`
PR with the package version, `CHANGELOG.md`, and `.release-please-manifest.json`.
The version policy is in [release-please-config.json](../release-please-config.json):
while below 1.0, `feat` and breaking changes bump the minor version; `fix` bumps
the patch version. Preserve existing release tags and manifest history.

Before merging:

1. Review the proposed version, changelog, and full diff, especially workflow and
   acceptance-script changes. License, copyright, and author changes need owner approval.
2. Find **Validate release PR / release-pr-validation** for the PR's exact current
   head. The validator runs for same-repository `release-please--` branches on
   `opened`, `synchronize`, and `reopened` events. Bot-triggered runs may need
   **Approve workflows to run**; review the diff before approving each updated run.
   If no run appears, inspect the workflow events and Release Please logs; do not merge.
3. Require a successful validation and inspect its **Summary** tab and logs for
   acceptance, consumer audit, and head freshness. An absent, pending, stale, or
   failed run is not success. This is not a required check enforced by the release
   workflow; verify the live branch rules and enforce this review before merging.
4. Recheck the current base and merge result. Freshness verifies the head and PR
   state at that check only, not the current base or merge result. A changed head
   needs new validation; a changed base needs renewed review and, where relevant,
   updated validation.

The PR validator checks out the exact PR head and runs typecheck, tests, build,
commit-subject checks, and artifact acceptance. It has read-only repository/PR
permissions and no publishing credentials. Its evidence is unsigned and diagnostic,
not a publishing attestation. Approval is not a security boundary: a PR can change
its workflow definition, so review that code rather than trusting a green check alone.

## 2. Automated publication

Merging the release PR triggers [release.yml](../.github/workflows/release.yml):

1. Release Please creates the release tag and GitHub Release.
2. The publisher checks out the exact tag, not floating `main`, and verifies that
   `vX.Y.Z` agrees with `package.json`.
3. It runs typecheck, tests, build, and fresh artifact acceptance. It never downloads
   or trusts the PR validator's artifact.
4. It publishes only the accepted tarball with `npm publish … --access public`,
   using OIDC trusted publishing.
5. It verifies the registry version and `dist.integrity` against the accepted
   metadata, retrying every five seconds for up to five minutes of propagation
   waits (registry request time is additional). A version or integrity mismatch
   fails immediately.

A GitHub Release or green PR check does not prove npm publication succeeded.
Confirm the publish job and registry-integrity verification both passed. The
publisher executes release code, so pre-merge review of that code remains essential.

### Artifact acceptance and security gates

[scripts/release-acceptance.ts](../scripts/release-acceptance.ts) is shared by PR
validation and publication. It:

- Exports the committed source with `git archive`, excluding untracked files and
  local build output, then installs, tests, and typechecks the clean export.
- Refuses an already-published version or an inconclusive registry lookup.
- Packs once and checks the manifest, host-runtime externals, and package contents:
  only `package.json`, `README.md`, `LICENSE`, `tui.js`, and `dist/tui.js` are allowed.
- Installs the tarball in a scratch production consumer with lifecycle scripts
  disabled, then audits that consumer's resolved dependencies, not the repository.
- Preserves the accepted tarball and its hashes in `artifact.json`.

High/critical advisories block acceptance with no waiver. The seroval advisories
GHSA-p6vx-979v-rg4c and GHSA-jp82-f5mq-hwhp were remediated by requiring
`@opentui/solid` and `@opentui/core` `^0.8.0` and `solid-js` `^1.9.17`, so a fresh
consumer resolves a patched `seroval`; the former scoped exception was retired. Any
future waiver would need a new owner-authorized, issue-linked, unexpired exception
added in code and documented here, and it would be not a clean audit. Audit errors
and malformed reports fail closed.

Do not bypass peer resolution with `--force` or `--legacy-peer-deps`, or suppress
engine/deprecation warnings to get a green release. Triage security findings and
deprecation notices; unresolved findings block release unless explicitly covered
by a documented exception. An issue alone does not remove a blocker.

### Evidence

Both workflows upload evidence when files exist, including after acceptance
failure. The release upload runs whenever the acceptance step ran; an early
failure may produce no artifact. Artifacts have a 14-day retention:

- PR: `release-pr-evidence-<PR>-<attempt>`.
- Publish: `release-evidence-<tag>`.

Depending on how far acceptance got, evidence contains the tarball, `artifact.json`,
raw `npm-audit-omit-dev.json` and optional stderr. PR validation also records `head-status.json`
when the freshness step runs. The human-readable summary is in the workflow run,
not the artifact directory. Identify evidence by run URL, attempt, and commit/tag,
not artifact name alone. Preserve needed evidence with the release record before
it expires; keep private session data out of shared records.

## 3. Verify the published plugin

These are owner-run checks after automated publication, not automated prepublish
gates. Unit tests and artifact acceptance do not prove live TUI behavior or
registry-name resolution.

Use a real OpenCode in tmux with scratch configuration and a standalone server.
Never alter the daily OpenCode configuration or restart its background service.
Follow the isolation and screen-capture requirements in [AGENTS.md](../AGENTS.md).
The development launcher loads the checkout, so it alone cannot verify the
published package: the checks below must load the registry package, not a local
path or symlink.

- Test named configuration with both `opencode-tokscope@X.Y.Z` and unversioned
  `opencode-tokscope` in separate scratch environments. Confirm the unversioned
  install resolves to the new version.
- Run `opencode plugin add opencode-tokscope` with scratch configuration. Confirm
  it records the TUI plugin in the expected `cli.json`, preserves existing keys,
  and loads successfully on the next standalone launch.
- Confirm exactly one Tokscope command, `/tokscope` opening and Escape return,
  sidebar rendering and click navigation, filters, and appropriate empty-history
  and real-history states. Use an isolated standalone host for real-history checks,
  not the daily session. Check cache restoration after relaunch.
- Reject missing-module, duplicate-runtime, or `No renderer found` errors.

Record the source tag/commit, package version, workflow run, tarball integrity,
audit decision, exact OpenCode version, and screen captures for runtime checks
in the release PR or linked issue—not as a running history in this guide.

If installation or runtime verification fails, stop recommending/distributing
that release, document the failure, and ship a corrected **new version** through
full acceptance. Never overwrite a published version or move its tag.

## Recovery

- **Failure before publication:** use **Actions → Release → Re-run failed jobs**
  on the original run to retain its Release Please outputs and repeat acceptance.
- **Original run cannot be retried:** use **Actions → Release → Run workflow**
  with `release_tag` set to an existing `vX.Y.Z`. Recovery requires a non-draft
  GitHub Release and matching tag/package version. It repeats acceptance and
  publication; it is not a PR-validation path.
- **Version already exists on npm:** do not retry publishing or bypass the
  duplicate-version guard. Compare its registry integrity with the original
  accepted `artifact.json`. If it matches, publication succeeded; investigate
  the remaining failed step. If it differs, stop and investigate.

Release tags and published npm versions are immutable. Dry runs do not publish
and never constitute publication approval.

## Manual fallback

Use only when CI publication is unavailable and the owner explicitly approves
manual publication. Work from the intended release commit with a clean tracked
tree and the workflow's tool versions. Set `SCRATCH_ROOT` to an approved temporary
directory and choose a fresh absolute evidence directory outside the checkout.
Run in one Bash shell from the repository root:

```bash
set -euo pipefail
export SCRATCH_ROOT="${SCRATCH_ROOT:?Set an approved temporary directory}"
ARTIFACT_DIR="$(mktemp -d "$SCRATCH_ROOT/tokscope-release-evidence.XXXXXX")"
bun scripts/release-acceptance.ts --output-dir "$ARTIFACT_DIR"
```

Review the evidence and smoke-test the installed tarball in an isolated host
before manual publication, including empty/real history and plugin discovery.
The owner must approve the exact artifact hash. Authenticate interactively with
the intended npm account and required 2FA; never paste credentials into chat.
Then publish the preserved bytes without rebuilding:

```bash
npm login
npm whoami
TARBALL="$(node -p 'require(process.argv[1]).path' "$ARTIFACT_DIR/artifact.json")"
npm publish "$TARBALL" --access public
bun scripts/release-acceptance.ts --verify-published "$ARTIFACT_DIR/artifact.json"
```

Do not use `--allow-published` for release acceptance. Keep the manifest version,
accepted artifact, registry version, and release tag aligned; do not create a
second tag or move an existing one. Complete the same postpublication checks
and release record as for automated publication.
