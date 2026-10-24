#!/bin/sh
# Shared commit subject gate: exit 0 when the subject is acceptable to
# Release Please, otherwise print guidance to stderr and exit 1.
set -u

allowlist='^(feat|fix|perf|revert|docs|test|build|ci|chore|refactor|style)(\([^()]+\))?!?: .+'
subject=${1-}

reject() {
  printf 'commit subject rejected: %s\n' "${subject:-<empty>}" >&2
  cat >&2 <<'EOF'
Allowed commit subjects:
  <type>[(<scope>)][!]: <description>
    <type> is one of: feat, fix, perf, revert, docs, test, build, ci, chore, refactor, style
    <scope> is optional and cannot contain parentheses
    ! marks a breaking change; a space and a non-empty description are required
  Merge branch ..., Merge pull request ..., Merge remote-tracking ..., Revert "...

Examples: feat: add provider filtering
          fix(chart)!: handle empty history
EOF
  exit 1
}

if [ -z "$subject" ]; then
  reject
fi

case "$subject" in
  'Merge branch '* | 'Merge pull request '* | 'Merge remote-tracking '* | 'Revert "'*)
    exit 0
    ;;
esac

if printf '%s\n' "$subject" | grep -Eq "$allowlist"; then
  exit 0
fi

reject
