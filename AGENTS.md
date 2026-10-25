# Subagent selection

When delegating implementation—including requests to "fan out" or "use subagents"—use the `coder` subagent defined in `.opencode/agents/coder.md`. For independent implementation tasks, launch separate `coder` instances in parallel with non-overlapping scopes. Use other specialized agents for exploration or review.

## Security and release blockers

- Address security issues, audit findings, and deprecation notices as soon as they are discovered. Fix them immediately whenever possible.
- Unresolved findings and notices block new releases unless covered by an explicit, documented exception.
- If an immediate fix is not possible:
  - Create a GitHub issue documenting the finding, the reason resolution is blocked, and next steps.
  - When supported and justified, create a narrowly scoped, time-limited audit exception linked to the issue to unblock the release.
- Never silently suppress findings. An issue alone does not remove a release blocker.
