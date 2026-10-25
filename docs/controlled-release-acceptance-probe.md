# Controlled release acceptance probe (TEST ONLY)

This document exists only to create a disposable, obviously test-only commit on the
branch `release-please--verification-failed-acceptance-20261025`. It is not part of
the product, the packaging allowlist, or the release procedure.

**Do not merge this pull request.** It is a one-off hosted negative test whose red
result is the expected outcome.

## Purpose

`main` at `529a7598d7c589e264a3ef782f4030d3ddbb430e` carries version `0.1.0`, and
`opencode-tokscope@0.1.0` is already published to npm. Published versions are
immutable, so `scripts/release-acceptance.ts` must refuse a version that is already
in the registry.

The probe exercises that refusal through the real PR-triggered
`.github/workflows/validate-release-pr.yml` run: identity verification, exact-head
checkout, install, typecheck, tests, build, and commit-subject checks are expected to
pass, and the acceptance step is expected to fail at the registry guard with
`version 0.1.0 is already published`. Because the guard stops before packing, no
tarball, `artifact.json`, consumer audit, or `head-status.json` is expected, and the
final evidence gate stays skipped while the native job conclusion is failure.

## Explicit limits

- No workflow, version, dependency, or product source change accompanies this file.
- The guard is never bypassed, and `--allow-published` is never passed in CI.
- Nothing here authorizes publication, tagging, or a release pull request.
- The branch is deleted only after the controller has verified the recorded run.
