import { expect, test } from "bun:test"

test("README defines usage and response columns independently of Speed eligibility", async () => {
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text()
  for (const text of ["Requests", "Tokens = input + output + reasoning", "Response", "p95", "cache read", "n/a", "tok/s = (tokens.output + tokens.reasoning) / ((time.streamed - time.created) / 1000)"]) expect(readme).toContain(text)
  expect(readme).not.toContain("measured/unavailable coverage remain visible")
  expect(readme).toContain("Failed, cancelled, and in-progress requests are excluded from Speed only")
  expect(readme).toContain("a missing stream end means no response measurement")
})
