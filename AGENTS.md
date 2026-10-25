# Subagent selection

When delegating implementation—including requests to "fan out" or "use subagents"—use the `coder` subagent defined in `.opencode/agents/coder.md`. For independent implementation tasks, launch separate `coder` instances in parallel with non-overlapping scopes. Use other specialized agents for exploration or review.

## Security and release blockers

- Address security issues, audit findings, and deprecation notices as soon as they are discovered. Fix them immediately whenever possible.
- Unresolved findings and notices block new releases unless covered by an explicit, documented exception.
- If an immediate fix is not possible:
  - Create a GitHub issue documenting the finding, the reason resolution is blocked, and next steps.
  - When supported and justified, create a narrowly scoped, time-limited audit exception linked to the issue to unblock the release.
- Never silently suppress findings. An issue alone does not remove a release blocker.

## Manual verification in a live host

Verify TUI-visible changes (page layout, widgets, keymaps, dialogs, persistence) by driving a real OpenCode in tmux — do not claim a change "works in a real host" from unit tests alone. Unit tests and headless fakes cover logic; only a live run covers rendering, keymaps, storage, and host integration.

Use `scripts/dev-opencode.sh`, which runs an isolated standalone OpenCode (v2.1.4+): a throwaway `XDG_CONFIG_HOME` that loads exactly this checkout's plugin build, a scratch project, and an untouched `XDG_DATA_HOME` so the instance reads the real session database read-only and writes only Tokscope's own plugin-storage keys. Your real global config, other plugins, and background service are never touched.

Workflow (run from the repo root):

```bash
# 0. Preflight: builds dist/tui.js, import smokes it, no UI
bash scripts/dev-opencode.sh --doctor

# 1. Build first, then start the TUI in a tmux session with a large window
mise exec bun@1.4.4 -- bun run build
tmux new-session -d -s tokscope-verify -x 180 -y 50 \
  'TOKSCOPE_SKIP_BUILD=1 bash scripts/dev-opencode.sh'

# 2. Read the screen and drive it
sleep 12                                  # wait for the home screen
tmux capture-pane -p -t tokscope-verify   # inspect what actually rendered
tmux send-keys -t tokscope-verify "/tokscope" Enter   # open the full page
tmux capture-pane -p -t tokscope-verify | grep -v '^ *$' | head -40

# 3. Exercise: keymaps (s/t/r/esc), dialogs, palette (ctrl+p), the sidebar
#    widget, and - for persistence - kill the session and relaunch, then
#    reopen the page and confirm cached analytics restored.

# 4. Clean up: kill the session and remove the throwaway scratch dirs
tmux kill-session -t tokscope-verify
rm -rf "${TMPDIR:-/tmp}"/opencode-tokscope-standalone.* 2>/dev/null
```

Notes:

- Invoke the script with `bash`, not `bun` — it is a shell script.
- Source edits require a rebuild and relaunch (`bun run build`, then restart the tmux session) unless `TOKSCOPE_SKIP_BUILD=1` is used deliberately to reuse the existing build.
- The plugin's durable cache lives at `~/.local/state/opencode/latest/tui/plugin.tokscope.history.tks.*.json` (host-prefixed `plugin.tokscope.history.`). Inspect those files to verify persistence, record shape, or reset scope; they are read by the running TUI.
- Screen capture is the evidence: paste relevant `capture-pane` output into reports rather than asserting what the screen "probably" showed. Transient status banners may need a capture loop with short sleeps to catch.
- Never verify against the user's daily OpenCode session; always go through this script.
