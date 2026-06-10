import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withExclusiveFileLock } from "../../src/engine/host/file-lock";

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
