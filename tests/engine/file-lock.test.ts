import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  inspectExclusiveFileLock,
  withExclusiveFileLock,
} from "../../src/engine/host/file-lock";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("withExclusiveFileLock", () => {
  test("reports busy when another holder owns the lock", async () => {
    const lockPath = tempLockPath();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = deferred<void>();

    const first = withExclusiveFileLock(
      { lockPath, command: "first" },
      async () => {
        entered.resolve();
        await released;
        return "done";
      },
    );
    await entered.promise;

    const second = await withExclusiveFileLock(
      { lockPath, command: "second" },
      async () => "unexpected",
    );
    expect(second.kind).toBe("busy");
    if (second.kind === "busy") {
      expect(second.lockPath).toBe(lockPath);
      expect(second.holder?.command).toBe("first");
    }

    release();
    await expect(first).resolves.toEqual({
      kind: "acquired",
      value: "done",
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  test("waits for a held lock and enters after release", async () => {
    const lockPath = tempLockPath();
    const order: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = deferred<void>();

    const first = withExclusiveFileLock(
      { lockPath, command: "first" },
      async () => {
        order.push("first-enter");
        entered.resolve();
        await released;
        order.push("first-exit");
        return "first";
      },
    );
    await entered.promise;

    const second = withExclusiveFileLock(
      {
        lockPath,
        command: "second",
        wait: { timeoutMs: 1_000, intervalMs: 5 },
      },
      async () => {
        order.push("second-enter");
        return "second";
      },
    );

    await sleep(20);
    expect(order).toEqual(["first-enter"]);
    release();

    await expect(first).resolves.toEqual({
      kind: "acquired",
      value: "first",
    });
    await expect(second).resolves.toEqual({
      kind: "acquired",
      value: "second",
    });
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });
});

describe("inspectExclusiveFileLock", () => {
  test("only proves a well-formed same-host dead PID stale", async () => {
    const lockPath = tempLockPath();
    expect(await inspectExclusiveFileLock(lockPath)).toEqual({ kind: "absent" });
    await mkdir(dirname(lockPath), { recursive: true });

    await writeFile(lockPath, "{}\n", "utf8");
    expect((await inspectExclusiveFileLock(lockPath)).kind).toBe("possibly-live");

    const holder = {
      token: randomUUID(),
      pid: 0x7fffffff,
      hostname: "some-other-host.invalid",
      command: "remote-host",
      acquiredAt: new Date().toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(holder)}\n`, "utf8");
    expect((await inspectExclusiveFileLock(lockPath)).kind).toBe("possibly-live");

    await writeFile(lockPath, `${JSON.stringify({
      ...holder,
      hostname: hostname(),
      command: "dead-local-host",
    })}\n`, "utf8");
    expect((await inspectExclusiveFileLock(lockPath)).kind).toBe("definitely-stale");

    await writeFile(lockPath, `${JSON.stringify({
      ...holder,
      pid: process.pid,
      hostname: hostname(),
      command: "live-local-host",
    })}\n`, "utf8");
    expect((await inspectExclusiveFileLock(lockPath)).kind).toBe("possibly-live");
  });
});

function tempLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dome-file-lock-"));
  tempDirs.push(dir);
  return join(dir, "locks", "test.lock");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = (value) => innerResolve(value as T | PromiseLike<T>);
  });
  return Object.freeze({ promise, resolve });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stale-break race (review H2): the takeover path was read → unlink →
// open("wx") with no recheck, so two contenders could both judge the same
// crashed-process lock stale, and the second contender's unlink would
// remove the first contender's *fresh* lock — two "exclusive" holders at
// once. Since this lock backs the compiler-host branch lock and the
// projection write lock, the failure mode is two concurrent adoption ticks
// on one branch. The crashed-daemon restart racing a `dome sync` is the
// realistic trigger, so this is a stress test over that exact shape.
describe("stale-lock takeover", () => {
  test("admits at most one holder at a time under contention", async () => {
    const { hostname } = await import("node:os");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

    for (let round = 0; round < 20; round += 1) {
      const lockPath = tempLockPath();
      await mkdir(dirname(lockPath), { recursive: true });
      // A crashed prior holder: same host, a pid that cannot be alive.
      await writeFile(
        lockPath,
        `${JSON.stringify({
          token: "stale-token",
          pid: 0x7fffffff,
          hostname: hostname(),
          command: "crashed-serve",
          acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
        })}\n`,
        "utf8",
      );

      let inside = 0;
      let maxInside = 0;
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          withExclusiveFileLock(
            { lockPath, command: `contender-${i}` },
            async () => {
              inside += 1;
              maxInside = Math.max(maxInside, inside);
              await sleep(5);
              inside -= 1;
            },
          ),
        ),
      );

      const acquired = results.filter((r) => r.kind === "acquired").length;
      expect(maxInside).toBe(1);
      expect(acquired).toBeGreaterThanOrEqual(1);
    }
  });

  test("single contender still breaks a stale lock and acquires", async () => {
    const { hostname } = await import("node:os");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

    const lockPath = tempLockPath();
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "stale-token",
        pid: 0x7fffffff,
        hostname: hostname(),
        command: "crashed-serve",
        acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
      })}\n`,
      "utf8",
    );

    const result = await withExclusiveFileLock(
      { lockPath, command: "recovering" },
      async () => "recovered",
    );
    expect(result).toEqual({ kind: "acquired", value: "recovered" });
    expect(existsSync(lockPath)).toBe(false);
  });
});
