# Releasing opencode-tokscope

This is the manual release procedure. It deliberately does not include CI publishing. Nothing here authorizes publication: every step below is a check, and the publish command runs only after explicit owner approval.

> **Dry runs do not publish.** `npm pack`, `npm pack --dry-run`, and `npm publish --dry-run` create or inspect local artifacts only. They are not evidence that a version exists on npm, and a successful dry run is not approval to publish.

## Approval gates

Stop and obtain explicit approval before each of these actions:

1. **Legal and metadata.** MIT licensing and the copyright holder are confirmed for release 0.1.0. Any later license, copyright, or author change needs a new decision.
2. **Artifact acceptance.** The exact tarball, SHA-256 hash, and npm integrity from the clean-source acceptance run must be recorded and approved. All required prepublication runtime checks must have passed, and the dependency/advisory review in section 4.1 must be current.
3. **Publication.** Confirm the exact package name and version, that the version is still unpublished, the npm account identity, the public file list, the current dependency/advisory review, and that every required runtime check passed. Pending or failed checks block publication. Approval to implement the release plan is **not** approval to publish.
4. **Public source hosting.** Publishing to npm does not require a public repository. Making the source public needs separate approval and the repository/history review described below.
5. **Tags and pushes.** Create or push a tag, or push a branch/remote, only with explicit approval for that action.

Never ask for or paste passwords, one-time codes, or npm tokens into chat. The owner authenticates interactively.

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

Re-run the consumer audit and re-evaluate reachability **before publication and no later than 2026-11-07, whichever comes first**. Any reachable or untriaged high/critical finding blocks release. An existing unreachable finding may be accepted only with its scope, rationale, and review date recorded in the release evidence; it must never be hidden or described as a clean audit.

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
- The consumer-scoped advisory audit was re-run before publication or by 2026-11-07, whichever comes first, and reachability was re-evaluated. Any reachable or untriaged high/critical finding blocks release; an unreachable finding is accepted only with recorded scope, rationale, and review date.
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

For each run, confirm exactly one Tokscope command, `/tokscope` navigation and Escape return, sidebar rendering and click navigation, the empty-history state, and no missing-module, duplicate-runtime, or `No renderer found` failure. The unversioned run must resolve to the newly published version and must not be satisfied by a local package, path, or symlink. Run the check with a pre-existing `cli.json` state too (create the file first with an unrelated key) and confirm the plugin entry is added while every pre-existing key survives.

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
  grep -F '"opencode-tokscope"' "$dir/config/opencode/cli.json"
  grep -F '"other": true' "$dir/config/opencode/cli.json"

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
- tarball filename, file list, SHA-256, and npm integrity;
- consumer install result;
- consumer-scoped `npm audit` exit code and JSON, severity buckets, advisory chain, reachability decision, scope/rationale, and review date. Record EBADENGINE/deprecation warnings separately from advisories;
- each prepublication smoke-test outcome: isolated empty history, real history, and genuine auto-discovery. Pending or failed checks block publication; they are not accepted as pending;
- postpublication named-resolution results for both `opencode-tokscope@0.1.0` and `opencode-tokscope`, and the `plugin add` acceptance result, including any stop-distribution decision;
- publication result and registry integrity comparison, if publication was approved.

## npm files review versus public source hosting

Reviewing the npm tarball is not a review of the repository. The tarball contains only the allowlisted runtime files plus README, LICENSE, and `package.json`. Public source hosting (or any repository whose history contains local-only internal plans, reports, or private data) exposes the full working tree, Git history, author metadata, and anything ever committed.

Before any public repository push or visibility change, separately review the complete tree and history for credentials, private session or project data, internal reports, large generated files, and unwanted personal information. Obtain explicit approval for that review and for the hosting action. Adding a repository URL, homepage, or bugs URL to `package.json` is a later metadata change, not part of the first publication unless hosting is approved first.

## Deferred follow-ups

Do not add these during the first manual release:

- CI publishing, including npm trusted publishing/OIDC and provenance.
- Screenshots or a demo with representative, sanitized data.
- Ecosystem and community plugin listings.

They follow only after the first manual release is verified.
