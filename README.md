# opencode-tokscope

An OpenCode v2 TUI plugin answering: **which models and providers are fastest in my actual usage?** and **is a model/provider getting faster or slower over time?**

Opens a full-screen `/tokscope` page with a median tok/s comparison table (one row per model + provider) and a per-model daily median trend, and adds a compact summary to the session sidebar.

## Sidebar

The bottom of the session sidebar shows the three fastest model/provider pairs from a rolling 24-hour window across **all projects** on the connected instance (not just the current session or project). A pair needs at least three measured requests inside the window to appear; one or two qualifying pairs show one or two rows, and none shows `No models with 3+ calls in 24h.`

Rows show the full model name and as much of the provider name as fits, followed by the integer median tok/s. Speeds are right-aligned under the `tok/s` heading; per-entry call counts and repeated units are omitted. The scope and window are fixed — the sidebar does not follow the full page's filters.

Click anywhere in the widget to open the full page. The widget refreshes when a model step completes and once a minute while visible; after a read failure the last successful rows stay on screen marked `(stale)`. The sidebar has no shortcut of its own — `/tokscope` and the command palette remain the keyboard entry points.

## Metric

One sample = one completed model request (an assistant step), including main-agent, subagent, and background activity.

```
tok/s = (tokens.output + tokens.reasoning) / ((time.streamed - time.created) / 1000)
```

- Matches OpenCode's native TUI throughput semantics: `time.streamed` is when the provider response body ended, so tool settlement time is excluded.
- Input and cache tokens never count toward generated-token throughput.
- Headline per model/provider is the **median of individual request rates** — not total tokens ÷ total duration, and not an average.
- Measured: completed, no error, `time.streamed` present, positive duration, and `output + reasoning > 0`.
- Unavailable: completed requests missing that data (older history). They appear as `unavailable` with `0` calls after measured rows, and are counted in the coverage line — never shown as `0.0 tok/s`.
- Failed, cancelled, and in-progress requests are excluded entirely.

Historical sessions are read through the running OpenCode server, so requests made before installing the plugin are included wherever the recorded data supports the metric. Daily trends bucket by local calendar day using the day the request completed; days without measurements are gaps, never zeros.

## Install

Requires an OpenCode V2 TUI. The packaged plugin is built against the OpenCode 2.1.2 API and development pins; the actual npm artifact was runtime-validated on OpenCode 2.1.4, while 2.1.2 was historically tested. Other 2.x versions are untested, and V1 is not supported.

The one-command install:

```bash
opencode plugin add opencode-tokscope
```

`plugin add` classifies the package as a TUI plugin (verified against the released OpenCode 2.1.4 CLI) and records it in `~/.config/opencode/cli.json` for you. Older 2.x CLIs whose `plugin add` predates TUI-class packages do not support this form.

Only if `opencode plugin add` does not work for some reason, add the plugin manually to the `plugins` array in `~/.config/opencode/cli.json`. Add or extend only that key; keep every unrelated setting already in the file. A minimal file looks like this:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-tokscope"]
}
```

To pin the first release instead of following the latest published version, use `opencode plugin add opencode-tokscope@0.1.0`, or put `"opencode-tokscope@0.1.0"` in the manual array entry.

OpenCode loads installed plugins automatically. Run `/tokscope`, or open the palette (`ctrl+p`) and pick "Tokscope". If the command does not appear, run `/reload`; restart OpenCode only when you changed dependencies that it does not watch for reloads.

## Releases

Releases are automated via Release Please, which proposes a release PR containing the version bump and changelog; merging that PR publishes to npm. The dispatched `release-pr-validation` check on the exact PR head runs typecheck, tests, build, commit-subject checks, and the same clean-export artifact, production-consumer, and advisory-acceptance preflight as the release, uploading its evidence to the validation run. Inspect that check and its artifacts before merging; a high/critical advisory without the exact unexpired exception described here makes the `release-pr-validation` check red, but it is not a branch-protection required check and `main` currently has no branch protection at all, so a red result does not mechanically stop a merge. Repository protections can change later. Workflow artifacts expire. A green preflight does not prove the OIDC trusted-publisher configuration or publish permission, nor future dependency resolution. Before publishing, the release job checks out the exact release tag, repeats the full acceptance and production consumer advisory audit, then publishes only the accepted tarball and verifies its registry integrity. Any failed check blocks publication. Every high/critical advisory blocks the consumer audit except the single owner-authorized, time-limited exception for the two seroval advisories on the pinned host-bound TUI chain (see `docs/releasing.md` §4.1). The exception binds the root package version to the artifact's current manifest version and pins the vulnerable transitive versions exactly. It is tracked by https://github.com/mihaellenic/opencode-tokscope/issues/2. It expires at `2026-11-07T00:00:00Z` (exclusive), refuses release on any new advisory, package, path, version, cycle, unresolved `via` reference, or malformed report, and is not a clean audit. Each release's contents are recorded in `CHANGELOG.md`.

The baseline is the published `opencode-tokscope@0.1.0` release and the `v0.1.0` tag; Release Please starts from that state.

`opencode plugin add opencode-tokscope` follows the `latest` published version. To pin a version, use `opencode-tokscope@X.Y.Z` as documented above.

## Local development (Bun)

Consumers install the published package; they do not need Bun or a build step. The npm artifact ships prebuilt JavaScript. The following setup is only for working on this repository.

Requires Bun.

```bash
bun install
bun run setup
bun run build
```

`bun run setup` registers the shared commit hook with `git config core.hooksPath githooks`. The hook rejects a first line that is not a Conventional Commit subject: allowed types are `feat`, `fix`, `perf`, `revert`, `docs`, `test`, `build`, `ci`, `chore`, `refactor`, and `style`, with an optional scope and `!`; Git-generated `Merge ...` and `Revert "..."` subjects are also accepted. CI runs the same `scripts/commit-subject-ok.sh`, so bypassing the hook does not bypass the gate.

`Bun.build` with the Solid transform from `@opentui/solid/bun-plugin` produces `dist/tui.js`. Host-provided modules stay **external** so OpenCode's runtime-plugin transform binds them to the TUI's own instances: `effect`, `@opencode/plugin` (and subpaths), `solid-js`, `@opentui/core`, `@opentui/solid`, `@opentui/keymap` (and subpaths). Bundling those produces a second Solid/OpenTUI runtime and the page fails with `No renderer found`.

Development pins match the tested host (`opencode v2.1.2`): `@opencode/plugin@2.1.2`, `@opencode/client@2.1.2`, `@opentui/*@0.6.6`, `solid-js@1.9.15`.

For local discovery, symlink the checkout into OpenCode's plugin directory:

```bash
mkdir -p ~/.config/opencode/plugins
ln -sfn /path/to/opencode-tokscope ~/.config/opencode/plugins/opencode-tokscope
```

OpenCode picks up the link automatically where it can; if it does not, run `/reload`. A full restart is only needed when development dependencies outside OpenCode's watch set change. Rebuild and reload after source edits.

```bash
bun test          # unit tests (metric, harvest, aggregation, chart, state)
bun run typecheck # tsc --noEmit (Bun.build strips types, so this is the type gate)
bun run build     # rebuild dist/tui.js, then reload OpenCode
```

## Usage

| Key | Action |
| --- | --- |
| `↑` / `↓` (or `k` / `j`) | Move row selection |
| `←` / `→` | Move day selection in the trend |
| `s` | Scope: current project / all projects |
| `t` | Time range: last 7 / 30 / 90 days, all history |
| `r` | Reasoning setting: all / a recorded setting / unknown |
| `esc` | Return to the previous screen |
| `enter` | Retry after a read error |

Defaults on open: all projects, last 30 days, all reasoning settings combined. Current project remains selectable. Header and footer always show the active filters and coverage (`N measured calls; M unavailable`).

## License

MIT. See [LICENSE](LICENSE).
