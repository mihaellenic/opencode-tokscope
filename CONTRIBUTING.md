# Contributing

Consumers install the published package; they do not need Bun or a build step. The npm artifact ships prebuilt JavaScript. The setup below is only for working on this repository.

Requires Bun.

```bash
bun install
bun run setup
bun run build
```

`bun run setup` registers the shared commit hook with `git config core.hooksPath githooks`. The hook rejects a first line that is not a Conventional Commit subject: allowed types are `feat`, `fix`, `perf`, `revert`, `docs`, `test`, `build`, `ci`, `chore`, `refactor`, and `style`, with an optional scope and `!`; Git-generated `Merge ...` and `Revert "..."` subjects are also accepted. CI runs the same `scripts/commit-subject-ok.sh`, so bypassing the hook does not bypass the gate.

`Bun.build` with the Solid transform from `@opentui/solid/bun-plugin` produces `dist/tui.js`. Host-provided modules stay **external** so OpenCode's runtime-plugin transform binds them to the TUI's own instances: `effect`, `@opencode/plugin` (and subpaths), `solid-js`, `@opentui/core`, `@opentui/solid`, `@opentui/keymap` (and subpaths). Bundling those produces a second Solid/OpenTUI runtime and the page fails with `No renderer found`.

Development pins match the tested host (`opencode v2.1.2`): `@opencode/plugin@2.1.2`, `@opencode/client@2.1.2`, `@opentui/*@0.6.6`, `solid-js@1.9.17`.

For local discovery, symlink the checkout into OpenCode's plugin directory:

```bash
mkdir -p ~/.config/opencode/plugins
ln -sfn /path/to/opencode-tokscope ~/.config/opencode/plugins/opencode-tokscope
```

OpenCode picks up the link automatically where it can; if it does not, run `/reload`. A full restart is only needed when development dependencies outside OpenCode's watch set change. Rebuild and reload after source edits.

`scripts/dev-opencode.sh` is a shorter alternative that does not touch your global config. It launches a `--standalone` OpenCode in a temporary project with a temporary config root that loads only this checkout's plugin, and rebuilds first. It reuses your real OpenCode data directory, so `/tokscope` shows actual session history:

```bash
scripts/dev-opencode.sh            # scratch project
scripts/dev-opencode.sh ~/code/app # start in an existing project
scripts/dev-opencode.sh --doctor   # preflight, build, and import checks only
```

Pass an existing project directory when you want the **Current project** filter to cover it. Since the isolated config root starts empty, global plugins, MCP servers, agents, and CLI settings are not loaded; provider credentials still come from the shared data directory.

```bash
bun test          # unit tests (metric, harvest, aggregation, chart, state)
bun run typecheck # tsc --noEmit (Bun.build strips types, so this is the type gate)
bun run build     # rebuild dist/tui.js, then reload OpenCode
```

## Releases

Releases are automated via Release Please: merging the release PR bumps the version, records `CHANGELOG.md`, tags, and publishes to npm through trusted publishing; see `docs/releasing.md` for the release procedure, acceptance gates, and the dependency-advisory policy.

## License

MIT. See [LICENSE](LICENSE).