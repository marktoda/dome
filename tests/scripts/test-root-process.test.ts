import { afterEach, describe, expect, test } from "bun:test";

import {
  spawnRootTestProcess,
  superviseRootTestChild,
  type PipedRootTestChild,
  type RootTestChild,
} from "../../scripts/test-root";

const children: RootTestChild[] = [];
const ownedProcessGroups: number[] = [];

afterEach(async () => {
  for (const pgid of ownedProcessGroups.splice(0)) {
    try { process.kill(-pgid, "SIGKILL"); } catch {}
  }
  for (const child of children.splice(0)) {
    try { child.kill(9); } catch {}
    await Promise.race([child.exited.catch(() => -1), Bun.sleep(1_000)]);
    try { child.unref(); } catch {}
  }
});

describe("root test real process supervision", () => {
  test("a deadline retires a TERM-ignoring owner and its TERM-ignoring descendant", async () => {
    if (process.platform === "win32") return;

    const child = spawnRootTestProcess([process.execPath, "-e", `
      const descendant = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`
        process.on("SIGTERM", () => {});
        console.log("ready");
        setInterval(() => {}, 1_000);
      `)}], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const reader = descendant.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      descendant.unref();
      process.on("SIGTERM", () => {});
      console.log(JSON.stringify({ ownerPid: process.pid, descendantPid: descendant.pid }));
      setInterval(() => {}, 1_000);
    `], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    ownedProcessGroups.push(child.pid);
    const { ownerPid, descendantPid } = await readPidPair(child);

    try {
      expect(await superviseRootTestChild(child, {
        timeoutMs: 20,
        shutdownGraceMs: 50,
      })).toMatchObject({
        kind: "timed-out",
        termination: "sigkill",
      });
      expect(isProcessAlive(ownerPid)).toBeFalse();
      expect(isProcessAlive(descendantPid)).toBeFalse();
    } finally {
      try { process.kill(-ownerPid, "SIGKILL"); } catch {}
    }
  });

  test("a direct owner exit still retires a live descendant before returning", async () => {
    const child = spawnRootTestProcess([process.execPath, "-e", `
      const descendant = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`
        process.on("SIGTERM", () => {});
        console.log("ready");
        setInterval(() => {}, 1_000);
      `)}], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const reader = descendant.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      descendant.unref();
      console.log(JSON.stringify({ ownerPid: process.pid, descendantPid: descendant.pid }));
      setTimeout(() => process.exit(37), 30);
    `], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    ownedProcessGroups.push(child.pid);
    const { ownerPid, descendantPid } = await readPidPair(child);

    expect(await superviseRootTestChild(child, {
      timeoutMs: 1_000,
      shutdownGraceMs: 50,
    })).toEqual({ kind: "exited", exitCode: 37 });
    expect(isProcessAlive(ownerPid)).toBeFalse();
    expect(isProcessAlive(descendantPid)).toBeFalse();
  });

  test("an owner interrupt retires descendants that outlive the direct child", async () => {
    const child = spawnRootTestProcess([process.execPath, "-e", `
      const descendant = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`
        process.on("SIGINT", () => {});
        process.on("SIGTERM", () => {});
        console.log("ready");
        setInterval(() => {}, 1_000);
      `)}], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const reader = descendant.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      descendant.unref();
      process.on("SIGINT", () => process.exit(42));
      console.log(JSON.stringify({ ownerPid: process.pid, descendantPid: descendant.pid }));
      setInterval(() => {}, 1_000);
    `], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    ownedProcessGroups.push(child.pid);
    const { ownerPid, descendantPid } = await readPidPair(child);

    expect(await superviseRootTestChild(child, {
      interrupted: Promise.resolve("SIGINT"),
      shutdownGraceMs: 50,
    })).toEqual({
      kind: "interrupted",
      signal: "SIGINT",
      termination: "sigkill",
      observedExitCode: 42,
    });
    expect(isProcessAlive(ownerPid)).toBeFalse();
    expect(isProcessAlive(descendantPid)).toBeFalse();
  });

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
      import { spawnRootTestProcess, superviseRootTestChild } from "./scripts/test-root.ts";
      const child = spawnRootTestProcess([process.execPath, "-e", ${JSON.stringify(`
        process.on("SIGTERM", () => {});
        console.log("ready");
        setInterval(() => {}, 1_000);
      `)}], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const reader = child.stdout.getReader();
      let readinessTimer;
      let ready;
      try {
        ready = await Promise.race([
          reader.read(),
          child.exited.then((exitCode) => {
            throw new Error(\`inner child exited before readiness (\${exitCode})\`);
          }),
          new Promise((_, reject) => {
            readinessTimer = setTimeout(
              () => reject(new Error("inner child was not ready")),
              1_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(readinessTimer);
        reader.releaseLock();
      }
      if (!new TextDecoder().decode(ready.value).includes("ready")) {
        throw new Error("inner child emitted malformed readiness");
      }
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

async function spawnReady(source: string): Promise<PipedRootTestChild> {
  const child = spawnRootTestProcess([process.execPath, "-e", source], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  ownedProcessGroups.push(child.pid);
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

async function readPidPair(child: PipedRootTestChild): Promise<Readonly<{
  ownerPid: number;
  descendantPid: number;
}>> {
  const reader = child.stdout.getReader();
  try {
    const first = await Promise.race([
      reader.read(),
      child.exited.then((exitCode) => {
        throw new Error(`fixture owner exited before readiness (${exitCode})`);
      }),
      Bun.sleep(1_000).then(() => { throw new Error("fixture owner was not ready"); }),
    ]);
    const parsed = JSON.parse(new TextDecoder().decode(first.value)) as {
      ownerPid: unknown;
      descendantPid: unknown;
    };
    if (!Number.isInteger(parsed.ownerPid) || !Number.isInteger(parsed.descendantPid)) {
      throw new Error("fixture owner emitted malformed process identifiers");
    }
    return Object.freeze({
      ownerPid: parsed.ownerPid as number,
      descendantPid: parsed.descendantPid as number,
    });
  } finally {
    reader.releaseLock();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
