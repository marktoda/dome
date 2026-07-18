import { afterEach, describe, expect, test } from "bun:test";

import { superviseRootTestChild } from "../../scripts/test-root";

const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(9); } catch {}
    await Promise.race([child.exited.catch(() => -1), Bun.sleep(1_000)]);
    try { child.unref(); } catch {}
  }
});

describe("root test real process supervision", () => {
  test("a deadline sends TERM and observes graceful child exit", async () => {
    const child = await spawnReady(`
      process.on("SIGTERM", () => process.exit(41));
      console.log("ready");
      setInterval(() => {}, 1_000);
    `);

    expect(await superviseRootTestChild(child, {
      timeoutMs: 20,
      shutdownGraceMs: 1_000,
    })).toEqual({
      kind: "timed-out",
      termination: "sigterm",
      observedExitCode: 41,
    });
  });

  test("an owner SIGINT reaches the child as SIGINT", async () => {
    const child = await spawnReady(`
      process.on("SIGINT", () => process.exit(42));
      console.log("ready");
      setInterval(() => {}, 1_000);
    `);

    expect(await superviseRootTestChild(child, {
      interrupted: Promise.resolve("SIGINT"),
      shutdownGraceMs: 1_000,
    })).toEqual({
      kind: "interrupted",
      signal: "SIGINT",
      termination: "sigint",
      observedExitCode: 42,
    });
  });

  test("a TERM-trapping child is escalated to KILL", async () => {
    const child = await spawnReady(`
      process.on("SIGTERM", () => {});
      console.log("ready");
      setInterval(() => {}, 1_000);
    `);

    const outcome = await superviseRootTestChild(child, {
      timeoutMs: 20,
      shutdownGraceMs: 50,
    });
    expect(outcome).toMatchObject({
      kind: "timed-out",
      termination: "sigkill",
    });
    if (outcome.kind === "timed-out") expect(outcome.observedExitCode).not.toBeNull();
  });

  test("a supervisor process finalizes boundedly after killing a stuck child", async () => {
    const outer = Bun.spawn([process.execPath, "-e", `
      import { superviseRootTestChild } from "./scripts/test-root.ts";
      const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1_000);
      `)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      const result = await superviseRootTestChild(child, {
        timeoutMs: 20,
        shutdownGraceMs: 50,
      });
      console.log(JSON.stringify(result));
    `], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(outer);

    const exitCode = await Promise.race([
      outer.exited,
      Bun.sleep(2_000).then(() => { throw new Error("outer supervisor did not finalize"); }),
    ]);
    const [stdout, stderr] = await Promise.all([
      new Response(outer.stdout).text(),
      new Response(outer.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      kind: "timed-out",
      termination: "sigkill",
    });
  });
});

async function spawnReady(source: string): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const reader = child.stdout.getReader();
  try {
    const first = await Promise.race([
      reader.read(),
      child.exited.then((exitCode) => {
        throw new Error(`fixture child exited before readiness (${exitCode})`);
      }),
      Bun.sleep(1_000).then(() => { throw new Error("fixture child was not ready"); }),
    ]);
    expect(new TextDecoder().decode(first.value)).toContain("ready");
  } finally {
    reader.releaseLock();
  }
  return child;
}
