import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  allowedArtifactFile,
  auditBlockers,
  bannedArtifactContent,
  classifyPublishedLookup,
  classifyRegistryLookup,
  createArtifactMetadata,
  parseAcceptanceArgs,
  preserveArtifact,
  publishedArtifactProblem,
  registryGuardDecision,
  sha256File,
  sha512SriFile,
  summarizeAudit,
  validateArtifactMetadata,
  verifyPublishedArtifact,
  type CommandResult,
} from "../scripts/release-acceptance"

describe("allowedArtifactFile", () => {
  test("accepts exactly the five published artifact paths", () => {
    for (const path of [
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/tui.js",
      "package/dist/tui.js",
    ]) {
      expect(allowedArtifactFile(path)).toBe(true)
    }
  })

  test("rejects undeclared paths", () => {
    for (const path of [
      "package/docs/internal.md",
      "package/dist/tui.js.map",
      "package/dist/other.js",
      "package/.npmrc",
      "package/package.json.bak",
      "package/task-4-report.md",
      "package/dist/",
      "",
    ]) {
      expect(allowedArtifactFile(path)).toBe(false)
    }
  })
})

describe("bannedArtifactContent", () => {
  test("flags internal report markers", () => {
    expect(bannedArtifactContent("see task-4-report.md for details", "/Users/miha")).toBe(true)
    expect(bannedArtifactContent("tasks-4-report", "/Users/miha")).toBe(false)
  })

  test("flags PEM private key blocks", () => {
    for (const block of [
      "BEGIN PRIVATE KEY",
      "BEGIN RSA PRIVATE KEY",
      "BEGIN OPENSSH PRIVATE KEY",
      "-----BEGIN EC PRIVATE KEY-----",
    ]) {
      expect(bannedArtifactContent(block, "/Users/miha")).toBe(true)
    }
    expect(bannedArtifactContent("PRIVATE KEY handling is documented", "/Users/miha")).toBe(false)
  })

  test("flags the absolute source checkout path", () => {
    expect(bannedArtifactContent("/Users/miha/x/dist/tui.js content", "/Users/miha")).toBe(true)
    expect(bannedArtifactContent("normal js", "/Users/miha")).toBe(false)
  })

  test("does not flag an empty source root", () => {
    expect(bannedArtifactContent("normal js", "")).toBe(false)
  })

  test("accepts ordinary bundled output", () => {
    expect(bannedArtifactContent('import { x } from "@opentui/core"\nexport default x', "/Users/miha")).toBe(false)
  })
})

const result = (code: number, stdout = "", stderr = ""): CommandResult => ({ code, stdout, stderr })

const e404 = JSON.stringify({
  error: {
    code: "E404",
    summary: "No match found",
    detail: "The requested resource could not be found.",
  },
})

const networkError = JSON.stringify({
  error: {
    code: "ENOTFOUND",
    summary: "network request failed",
    detail: "getaddrinfo ENOTFOUND registry.npmjs.org",
  },
})

describe("classifyRegistryLookup", () => {
  test("recognises npm's --json E404 as unpublished", () => {
    expect(classifyRegistryLookup(result(1, e404, "npm error code E404"))).toEqual({ status: "unpublished" })
  })

  test("does not treat auth or network errors as unpublished", () => {
    const outage = classifyRegistryLookup(result(1, networkError, "npm error network"))
    expect(outage.status).toBe("error")
    expect(outage.status === "error" ? outage.code : undefined).toBe("ENOTFOUND")

    const auth = classifyRegistryLookup(result(1, JSON.stringify({ error: { code: "E401" } }), ""))
    expect(auth.status).toBe("error")
    expect(auth.status === "error" ? auth.code : undefined).toBe("E401")
  })

  test("fails closed on unparsable error output", () => {
    const output = classifyRegistryLookup(result(1, "something went wrong", ""))
    expect(output.status).toBe("error")
    expect(output.status === "error" ? output.detail : "").toContain("something went wrong")
  })

  test("reads a published exact version", () => {
    expect(classifyRegistryLookup(result(0, '"0.1.0"'))).toEqual({ status: "published", version: "0.1.0" })
    expect(classifyRegistryLookup(result(0, '["0.1.0"]'))).toEqual({ status: "published", version: "0.1.0" })
  })

  test("rejects a success response without a version", () => {
    expect(classifyRegistryLookup(result(0, "{}")).status).toBe("error")
  })
})

describe("registryGuardDecision", () => {
  test("allows an unpublished version", () => {
    expect(registryGuardDecision({ status: "unpublished" }, { allowPublished: false }).ok).toBe(true)
  })

  test("hard-fails a duplicate version by default", () => {
    const decision = registryGuardDecision({ status: "published", version: "0.1.0" }, { allowPublished: false })
    expect(decision.ok).toBe(false)
    expect(decision.ok ? "" : decision.detail).toContain("already published")
  })

  test("allows an explicit local duplicate bypass with a warning", () => {
    const decision = registryGuardDecision({ status: "published", version: "0.1.0" }, { allowPublished: true })
    expect(decision.ok).toBe(true)
    expect(decision.ok ? decision.warning : "").toContain("--allow-published")
  })

  test("never bypasses a registry error, even with --allow-published", () => {
    const decision = registryGuardDecision(
      { status: "error", code: "ENOTFOUND", detail: "network down" },
      { allowPublished: true },
    )
    expect(decision.ok).toBe(false)
    expect(decision.ok ? "" : decision.detail).toContain("refusing to guess")
  })
})

describe("parseAcceptanceArgs", () => {
  test("requires an explicit output directory for acceptance", () => {
    expect(() => parseAcceptanceArgs([], {})).toThrow("--output-dir is required")
  })

  test("accepts both output-directory forms", () => {
    expect(parseAcceptanceArgs(["--output-dir", "artifact"], {})).toEqual({
      mode: "accept",
      outputDir: "artifact",
      allowPublished: false,
    })
    expect(parseAcceptanceArgs(["--output-dir=artifact"], {})).toEqual({
      mode: "accept",
      outputDir: "artifact",
      allowPublished: false,
    })
  })

  test("accepts explicit local duplicate validation", () => {
    expect(parseAcceptanceArgs(["--output-dir", "artifact", "--allow-published"], {})).toEqual({
      mode: "accept",
      outputDir: "artifact",
      allowPublished: true,
    })
  })

  test("refuses the duplicate bypass in CI", () => {
    expect(() => parseAcceptanceArgs(["--output-dir", "artifact", "--allow-published"], { CI: "true" })).toThrow()
    expect(() =>
      parseAcceptanceArgs(["--output-dir", "artifact", "--allow-published"], { GITHUB_ACTIONS: "true" }),
    ).toThrow()
  })

  test("parses verification metadata mode", () => {
    expect(parseAcceptanceArgs(["--verify-published", "artifact.json"], {})).toEqual({
      mode: "verify",
      metadataPath: "artifact.json",
    })
  })

  test("rejects mixed or unknown modes", () => {
    expect(() => parseAcceptanceArgs(["--verify-published", "artifact.json", "--output-dir", "out"], {})).toThrow()
    expect(() => parseAcceptanceArgs(["--verify-published", "artifact.json", "--allow-published"], {})).toThrow()
    expect(() => parseAcceptanceArgs(["--wat"], {})).toThrow("unknown argument")
  })
})

const metadataInput = {
  name: "opencode-tokscope",
  version: "9.9.9",
  filename: "opencode-tokscope-9.9.9.tgz",
  path: "/tmp/opencode-tokscope-9.9.9.tgz",
  integrity: "sha512-abc",
  shasum: "abc",
  sha256: "def",
}

describe("artifact metadata", () => {
  test("creates metadata only for the matching artifact filename", () => {
    expect(createArtifactMetadata(metadataInput)).toEqual(metadataInput)
    expect(() => createArtifactMetadata({ ...metadataInput, filename: "other.tgz" })).toThrow("does not match")
  })

  test("requires every field and an npm SRI integrity", () => {
    expect(() => createArtifactMetadata({ ...metadataInput, integrity: "" })).toThrow("missing")
    expect(() => createArtifactMetadata({ ...metadataInput, integrity: "sha256-abc" })).toThrow("sha512")
  })

  test("validates metadata read back from disk", () => {
    expect(validateArtifactMetadata(metadataInput)).toEqual(metadataInput)
    expect(() => validateArtifactMetadata(null)).toThrow("not an object")
    const { path: _path, ...missingPath } = metadataInput
    expect(() => validateArtifactMetadata(missingPath)).toThrow("path")
  })
})

describe("file hashes", () => {
  test("computes the known SHA-256 and sha512 SRI of an empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-hash-"))
    try {
      const empty = join(dir, "empty")
      writeFileSync(empty, "")
      expect(sha256File(empty)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
      expect(sha512SriFile(empty)).toBe(
        "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("preserveArtifact", () => {
  test("copies the accepted tarball and writes matching metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-preserve-"))
    try {
      const source = join(dir, "opencode-tokscope-9.9.9.tgz")
      const outputDir = join(dir, "output")
      writeFileSync(source, "hello")
      const integrity = "sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw=="
      const metadata = preserveArtifact({
        source,
        outputDir,
        name: "opencode-tokscope",
        version: "9.9.9",
        filename: "opencode-tokscope-9.9.9.tgz",
        integrity,
        shasum: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      })

      expect(metadata.path).toBe(join(outputDir, "opencode-tokscope-9.9.9.tgz"))
      expect(readFileSync(metadata.path, "utf8")).toBe("hello")
      expect(metadata.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
      expect(sha512SriFile(metadata.path)).toBe(integrity)
      expect(JSON.parse(readFileSync(join(outputDir, "artifact.json"), "utf8"))).toEqual(metadata)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects a tarball whose bytes do not match npm's integrity", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-preserve-bad-"))
    try {
      const source = join(dir, "opencode-tokscope-9.9.9.tgz")
      const outputDir = join(dir, "output")
      writeFileSync(source, "hello")
      expect(() =>
        preserveArtifact({
          source,
          outputDir,
          name: "opencode-tokscope",
          version: "9.9.9",
          filename: "opencode-tokscope-9.9.9.tgz",
          integrity: "sha512-wrong",
          shasum: "abc",
        }),
      ).toThrow("does not match npm pack integrity")
      expect(existsSync(join(outputDir, "artifact.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const zeroAudit = JSON.stringify({
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  },
})

const highAudit = JSON.stringify({
  vulnerabilities: {
    seroval: {
      name: "seroval",
      severity: "high",
      via: [{ url: "https://github.com/advisories/GHSA-test-high", title: "high advisory" }],
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
  },
})

const criticalAudit = JSON.stringify({
  vulnerabilities: {
    "opencode-tokscope": {
      name: "opencode-tokscope",
      severity: "critical",
      via: ["seroval"],
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 },
  },
})

describe("summarizeAudit", () => {
  test("accepts a clean audit", () => {
    const summary = summarizeAudit(zeroAudit)
    expect(summary.high).toBe(0)
    expect(summary.critical).toBe(0)
    expect(summary.entries).toEqual([])
  })

  test("reports high and critical entries with advisory identifiers", () => {
    const high = summarizeAudit(highAudit)
    expect(high.high).toBe(1)
    expect(high.entries).toEqual([
      {
        name: "seroval",
        severity: "high",
        advisories: ["https://github.com/advisories/GHSA-test-high"],
      },
    ])

    const critical = summarizeAudit(criticalAudit)
    expect(critical.critical).toBe(1)
    expect(critical.entries[0]?.advisories).toEqual(["seroval"])
  })

  test("fails closed on malformed or network-error output", () => {
    expect(() => summarizeAudit("not json")).toThrow()
    expect(() => summarizeAudit(JSON.stringify({ error: { code: "ENETUNREACH" } }))).toThrow("vulnerabilities")
    expect(() => summarizeAudit(JSON.stringify({ vulnerabilities: {} }))).toThrow("metadata.vulnerabilities")
  })

  test("fails closed when npm's metadata disagrees with the entries", () => {
    const inconsistent = JSON.stringify({
      vulnerabilities: {},
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      },
    })
    expect(() => summarizeAudit(inconsistent)).toThrow("disagrees")
  })

  test("fails closed on an unknown severity or malformed advisory", () => {
    expect(() =>
      summarizeAudit(
        JSON.stringify({
          vulnerabilities: { pkg: { severity: "urgent", via: [] } },
          metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
        }),
      ),
    ).toThrow("unknown severity")

    expect(() =>
      summarizeAudit(
        JSON.stringify({
          vulnerabilities: { pkg: { severity: "high", via: [null] } },
          metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
        }),
      ),
    ).toThrow("malformed advisory")
  })
})

type AuditReport = {
  vulnerabilities: Record<string, { name?: string; severity?: string; via: unknown[] }>
  metadata: { vulnerabilities: Record<string, number> }
}

const serovalChain = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "npm-audit-seroval-chain.json"), "utf8"),
) as AuditReport

const APPROVED_ADVISORIES = [
  "https://github.com/advisories/GHSA-p6vx-979v-rg4c",
  "https://github.com/advisories/GHSA-jp82-f5mq-hwhp",
]

describe("strict audit gate", () => {
  test("passes a clean report and non-blocking severities", () => {
    expect(auditBlockers(summarizeAudit(zeroAudit))).toBeUndefined()
    const moderate = JSON.stringify({
      vulnerabilities: { pkg: { name: "pkg", severity: "moderate", via: [{ url: "https://example.test/a" }] } },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } },
    })
    expect(auditBlockers(summarizeAudit(moderate))).toBeUndefined()
  })

  test("blocks the formerly waived seroval advisory chain", () => {
    const summary = summarizeAudit(JSON.stringify(serovalChain))
    expect(summary.high + summary.critical).toBeGreaterThan(0)
    const detail = auditBlockers(summary)
    expect(detail).toContain("block release")
    for (const url of APPROVED_ADVISORIES) expect(detail).toContain(url)
    for (const name of ["seroval", "solid-js", "@opentui/solid", "@opencode/plugin", "opencode-tokscope"]) {
      expect(detail).toContain(name)
    }
  })

  test("blocks a single high or critical entry", () => {
    expect(auditBlockers(summarizeAudit(highAudit))).toContain("1 high and 0 critical")
    expect(auditBlockers(summarizeAudit(criticalAudit))).toContain("0 high and 1 critical")
  })

  test("has no exception module or waiver path left", () => {
    expect(existsSync(join(import.meta.dir, "..", "scripts", "audit-exception.ts"))).toBe(false)
    const script = readFileSync(join(import.meta.dir, "..", "scripts", "release-acceptance.ts"), "utf8")
    expect(script).not.toContain("audit-exception")
    expect(script).not.toContain("accepted-audit-exceptions")
  })
})

describe("published artifact verification", () => {
  test("classifies a matching registry response", () => {
    const response = classifyPublishedLookup(
      result(0, JSON.stringify({ version: "9.9.9", "dist.integrity": "sha512-abc" })),
    )
    expect(response).toEqual({ status: "published", version: "9.9.9", integrity: "sha512-abc" })
  })

  test("classifies an E404 response as an error for retry", () => {
    const response = classifyPublishedLookup(result(1, e404, "npm error code E404"))
    expect(response.status).toBe("error")
    expect(response.status === "error" ? response.code : undefined).toBe("E404")
  })

  test("compares the accepted artifact with the published artifact", () => {
    expect(publishedArtifactProblem({ version: "9.9.9", integrity: "sha512-abc" }, metadataInput)).toBeNull()
    expect(publishedArtifactProblem({ version: "9.9.8", integrity: "sha512-abc" }, metadataInput)).toContain("version")
    expect(publishedArtifactProblem({ version: "9.9.9", integrity: "sha512-other" }, metadataInput)).toContain(
      "integrity",
    )
  })

  test("retries bounded propagation errors before succeeding", async () => {
    const metadata = createArtifactMetadata(metadataInput)
    const waits: number[] = []
    let calls = 0
    const outcome = await verifyPublishedArtifact(
      metadata,
      () => {
        calls += 1
        return calls < 3
          ? { status: "error", code: "E404", detail: "not found yet" }
          : { status: "published", version: "9.9.9", integrity: "sha512-abc" }
      },
      { attempts: 4, delayMs: 7, wait: async (ms) => void waits.push(ms) },
    )

    expect(outcome).toEqual({ ok: true, detail: "registry opencode-tokscope@9.9.9 matches accepted integrity", attempts: 3 })
    expect(calls).toBe(3)
    expect(waits).toEqual([7, 7])
  })

  test("allows five minutes of propagation waits by default and succeeds on the last lookup", async () => {
    let elapsedMs = 0
    const outcome = await verifyPublishedArtifact(
      createArtifactMetadata(metadataInput),
      () => elapsedMs < 300_000
        ? { status: "error", code: "E404", detail: "not found yet" }
        : { status: "published", version: "9.9.9", integrity: "sha512-abc" },
      { wait: async (ms) => { elapsedMs += ms } },
    )

    expect(outcome.ok).toBe(true)
    expect(elapsedMs).toBe(300_000)
    expect(outcome.attempts).toBe(61)
  })

  test("stops after five minutes of propagation waits by default if the version stays unavailable", async () => {
    let elapsedMs = 0
    const outcome = await verifyPublishedArtifact(
      createArtifactMetadata(metadataInput),
      () => ({ status: "error", code: "E404", detail: "not found" }),
      { wait: async (ms) => { elapsedMs += ms } },
    )

    expect(outcome.ok).toBe(false)
    expect(elapsedMs).toBe(300_000)
    expect(outcome.attempts).toBe(61)
  })

  test("stops after the bounded attempt count", async () => {
    const metadata = createArtifactMetadata(metadataInput)
    const waits: number[] = []
    const outcome = await verifyPublishedArtifact(
      metadata,
      () => ({ status: "error", code: "E404", detail: "not found" }),
      { attempts: 3, delayMs: 11, wait: async (ms) => void waits.push(ms) },
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.attempts).toBe(3)
    expect(outcome.detail).toContain("after 3 attempt(s)")
    expect(waits).toEqual([11, 11])
  })

  test("fails immediately when the registry serves different bytes", async () => {
    const metadata = createArtifactMetadata(metadataInput)
    let calls = 0
    const outcome = await verifyPublishedArtifact(
      metadata,
      () => {
        calls += 1
        return { status: "published", version: "9.9.9", integrity: "sha512-other" }
      },
      { attempts: 5, wait: async () => {} },
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.attempts).toBe(1)
    expect(calls).toBe(1)
    expect(outcome.detail).toContain("integrity")
  })
})
