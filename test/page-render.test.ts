import { expect, test } from "bun:test"

// The TUI uses client Solid; isolate its export condition from the server-Solid pure tests.
test("OpenTUI page rendering and reactive wiring regressions", async () => {
  const child = Bun.spawn([process.execPath, "--conditions=browser", "test", "./test/fixtures/page-render.case.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect({ exit, output: stdout + stderr }).toMatchObject({ exit: 0 })
}, 30000)
