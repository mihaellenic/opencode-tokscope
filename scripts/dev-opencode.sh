#!/usr/bin/env bash
# dev-opencode.sh — run a STANDALONE OpenCode with only this checkout's
# tokscope plugin loaded. Your real ~/.config/opencode is never modified.
#
#   scripts/dev-opencode.sh                  throwaway scratch project, all history
#   scripts/dev-opencode.sh ~/code/my-app    start in an existing project
#   scripts/dev-opencode.sh --doctor         run preflight checks only, no UI
#   TOKSCOPE_SKIP_BUILD=1 scripts/dev-opencode.sh   reuse the current dist/tui.js
#   OPENCODE_PRINT_LOGS=1 OPENCODE_LOG_LEVEL=debug scripts/dev-opencode.sh
#
# How isolation works (verified against OpenCode 2.1.4):
#   - XDG_CONFIG_HOME points at a temporary config root whose cli.json loads
#     exactly one plugin: this checkout. Tokscope is a TUI-only package (it
#     exports "./tui" but no server entrypoint), so it belongs in cli.json
#     rather than the server's opencode.jsonc plugin list. The real global
#     config, plugins, MCP servers, agents, and CLI settings are not loaded.
#   - XDG_DATA_HOME is NOT overridden: the standalone server reads your real
#     OpenCode database, so the page and sidebar show actual session history
#     instead of an empty instance.
#   - --standalone runs a private server; your background service is untouched.
#   - The server starts inside the project directory, so a scratch default keeps
#     this checkout's .opencode/ and .superpowers/ churn out of reach: watching
#     them would trigger constant plugin reloads.
#   - No snapshot copy is needed. OpenCode reads the plugin package once at
#     startup, so the checkout is used in place; rebuild and relaunch to pick up
#     source edits.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DOCTOR=0
if [ "${1:-}" = "--doctor" ]; then
  DOCTOR=1
  shift
fi

# --- preflight ---------------------------------------------------------------
if ! command -v opencode >/dev/null 2>&1; then
  echo "✗ opencode not on PATH" >&2
  exit 1
fi
OPENCODE_VERSION="$(env -u OPENCODE_PRINT_LOGS -u OPENCODE_LOG_LEVEL opencode --version 2>/dev/null | head -1)"
echo "▶ OpenCode: ${OPENCODE_VERSION:-unknown}"
echo "▶ Plugin:   ${PLUGIN_ROOT}"

if command -v bun >/dev/null 2>&1 && bun --version >/dev/null 2>&1; then
  BUN=(bun)
else
  echo "▶ bun is not usable on PATH; falling back to npx -y bun@1.4.4"
  BUN=(npx -y bun@1.4.4)
fi

if [ ! -d "${PLUGIN_ROOT}/node_modules/@opencode/plugin" ]; then
  echo "▶ installing dependencies (frozen lockfile, scripts disabled)..."
  (cd "${PLUGIN_ROOT}" && "${BUN[@]}" install --frozen-lockfile --ignore-scripts)
fi

# The published entrypoint is dist/tui.js, which is gitignored and must exist
# before OpenCode resolves the package's TUI entrypoint.
if [ "${TOKSCOPE_SKIP_BUILD:-0}" != "1" ]; then
  echo "▶ build..."
  (cd "${PLUGIN_ROOT}" && "${BUN[@]}" scripts/build.ts)
fi
if [ ! -s "${PLUGIN_ROOT}/dist/tui.js" ]; then
  echo "✗ ${PLUGIN_ROOT}/dist/tui.js is missing; run without TOKSCOPE_SKIP_BUILD=1" >&2
  exit 1
fi

# Import smoke: catches bundling and peer-resolution errors before the TUI does.
echo "▶ import smoke..."
(cd "${PLUGIN_ROOT}" && "${BUN[@]}" -e "await import('./dist/tui.js'); console.log('  imports ok')")
if [ "${DOCTOR}" = "1" ]; then
  echo "✓ doctor done"
  exit 0
fi

# --- isolated environment ----------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opencode-tokscope-standalone.XXXXXX")"
CONFIG_ROOT="${WORK}/config"
CACHE_DIR="${WORK}/cache"
SCRATCH="${WORK}/scratch"
mkdir -p "${CONFIG_ROOT}/opencode" "${CACHE_DIR}" "${SCRATCH}"

cat > "${CONFIG_ROOT}/opencode/cli.json" <<JSON
{
  "\$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [{ "package": "file://${PLUGIN_ROOT}" }]
}
JSON

cat > "${CONFIG_ROOT}/opencode/opencode.jsonc" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json"
}
JSON

TARGET="${1:-${SCRATCH}}"
if [ ! -d "${TARGET}" ]; then
  echo "✗ not a directory: ${TARGET}" >&2
  exit 1
fi
echo "▶ isolated config root: ${CONFIG_ROOT}"
echo "▶ project: $(cd "${TARGET}" && pwd)"
echo "▶ real session data is used (XDG_DATA_HOME untouched)"
echo "▶ open the page with /tokscope or Ctrl+P → Tokscope"

# --- launch ------------------------------------------------------------------
ARGS=(--standalone)
if [ "${OPENCODE_PRINT_LOGS:-0}" = "1" ]; then
  ARGS+=(--print-logs)
fi

cd "${TARGET}"
XDG_CONFIG_HOME="${CONFIG_ROOT}" \
XDG_CACHE_HOME="${CACHE_DIR}" \
exec opencode "${ARGS[@]}"
