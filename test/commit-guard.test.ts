import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

const checkSubject = (subject: string) =>
  Bun.spawnSync(["sh", "scripts/commit-subject-ok.sh", subject], { cwd: root })

const checkMessage = (firstLine: string) => {
  const dir = mkdtempSync(join(tmpdir(), "commit-guard-"))
  const messagePath = join(dir, "COMMIT_EDITMSG")
  try {
    writeFileSync(messagePath, `${firstLine}\n\nbody text\n`)
    return Bun.spawnSync(["sh", "githooks/commit-msg", messagePath], { cwd: root })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("commit subject guard", () => {
  for (const subject of [
    "feat: add provider filtering",
    "fix(chart)!: handle empty history",
    "chore(main): release 0.1.1",
    "docs: update README",
  ]) {
    test(`accepts ${JSON.stringify(subject)}`, () => {
      expect(checkSubject(subject).exitCode).toBe(0)
    })
  }

  for (const subject of [
    "updated stuff",
    "feat",
    "merge some things",
    "feat:no space",
    "fix(scope):",
    "",
  ]) {
    test(`rejects ${JSON.stringify(subject)} with guidance`, () => {
      const result = checkSubject(subject)
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString().trim()).not.toBe("")
    })
  }

  test("allows merge and revert subjects git creates on its own", () => {
    for (const subject of [
      "Merge branch 'main' into feature",
      "Merge pull request #12 from miha/topic",
      "Merge remote-tracking branch 'origin/main'",
      'Revert "feat: add provider filtering"',
    ]) {
      expect(checkSubject(subject).exitCode).toBe(0)
    }
  })
})

describe("commit-msg hook", () => {
  test("passes a conventional first line", () => {
    expect(checkMessage("fix: ok").exitCode).toBe(0)
  })

  test("fails a non-conventional first line", () => {
    expect(checkMessage("nope").exitCode).toBe(1)
  })
})

describe("setup script", () => {
  test("registers the hooks directory without lifecycle hooks", () => {
    expect(manifest.scripts.setup).toBe("git config core.hooksPath githooks")
    for (const hook of ["preinstall", "install", "postinstall"]) {
      expect(manifest.scripts[hook]).toBeUndefined()
    }
  })
})
