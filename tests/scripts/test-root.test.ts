import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  createRootTestPlan,
  discoverRootTestFiles,
  ROOT_TEST_FILE_TIMEOUT_MS,
  ROOT_TEST_AREA_ORDER,
  ROOT_TEST_TIMEOUT_EXIT_CODE,
  rootTestCommand,
  rootTestRequiresForcedExit,
  rootTestSignalExitCode,
  rootTestTimeoutDiagnostic,
  superviseRootTestChild,
  type RootTestChild,
  type RootTestWaitWithin,
} from "../../scripts/test-root";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

describe("root test runner", () => {
  test("classifies every file once in fixed area and file order", () => {
    const plan = createRootTestPlan([
      "tests/z-last.test.ts",
      "tests/product/z-product.test.ts",
      "tests/scripts/b-script.test.ts",
      "tests/harness/a-harness.test.ts",
      "tests/scripts/a-script.test.ts",
      "tests/engine/a-runtime.test.ts",
    ]);

    expect(plan.map((area) => area.name)).toEqual([...ROOT_TEST_AREA_ORDER]);
    expect(plan.map((area) => area.files)).toEqual([
      ["tests/scripts/a-script.test.ts", "tests/scripts/b-script.test.ts"],
      ["tests/harness/a-harness.test.ts"],
      ["tests/product/z-product.test.ts"],
      ["tests/engine/a-runtime.test.ts", "tests/z-last.test.ts"],
    ]);
    for (const area of plan) {
      expect(Object.isFrozen(area)).toBeTrue();
      expect(Object.isFrozen(area.files)).toBeTrue();
    }
  });

  test("builds one exact Bun command for one canonical test file", () => {
    const command = rootTestCommand("./tests/product/example.test.ts", "/opt/bun");

    expect(command).toEqual(["/opt/bun", "test", "tests/product/example.test.ts"]);
  });

  test("rejects duplicate and non-root test paths instead of silently changing coverage", () => {
    expect(() => createRootTestPlan([
      "tests/example.test.ts",
      "./tests/example.test.ts",
    ])).toThrow("duplicate root test path: tests/example.test.ts");
    expect(() => createRootTestPlan(["pwa/tests/example.test.ts"]))
      .toThrow("invalid root test path");
    expect(() => createRootTestPlan(["tests/../outside.test.ts"]))
      .toThrow("invalid root test path");
  });

  test("maps owned cancellation to conventional nonzero process status", () => {
    expect(rootTestSignalExitCode("SIGINT")).toBe(130);
    expect(rootTestSignalExitCode("SIGTERM")).toBe(143);
  });

  test("preserves a prompt child exit without sending a signal", async () => {
    const signals: number[] = [];
    const child: RootTestChild = {
      exited: Promise.resolve(7),
      kill: (signal = 15) => { signals.push(signal); },
      unref: () => {},
    };

    expect(await superviseRootTestChild(child, { timeoutMs: 1, shutdownGraceMs: 1 }))
      .toEqual({ kind: "exited", exitCode: 7 });
    expect(signals).toEqual([]);
  });

  test("escalates a deadline from TERM to KILL and observes the killed child", async () => {
    let resolveExit!: (exitCode: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    const signals: number[] = [];
    const child: RootTestChild = {
      exited,
      kill: (signal = 15) => {
        signals.push(signal);
        if (signal === 9) resolveExit(137);
      },
      unref: () => {},
    };
    let waitCount = 0;
    const waitWithin: RootTestWaitWithin = async <T>(promise: Promise<T>) => {
      waitCount += 1;
      if (waitCount <= 2) return { kind: "timeout" };
      return { kind: "settled", value: await promise };
    };

    expect(await superviseRootTestChild(child, {
      timeoutMs: 300_000,
      shutdownGraceMs: 5_000,
      waitWithin,
    })).toEqual({
      kind: "timed-out",
      termination: "sigkill",
      observedExitCode: 137,
    });
    expect(signals).toEqual([15, 9]);
    expect(waitCount).toBe(3);
  });

  test("turns an owner interruption into bounded graceful child cleanup", async () => {
    let resolveExit!: (exitCode: number) => void;
    const signals: number[] = [];
    const child: RootTestChild = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      kill: (signal = 15) => {
        signals.push(signal);
        if (signal === 15) resolveExit(143);
      },
      unref: () => {},
    };

    expect(await superviseRootTestChild(child, {
      interrupted: Promise.resolve("SIGTERM"),
      waitWithin: async <T>(promise: Promise<T>) => ({
        kind: "settled",
        value: await promise,
      }),
    })).toEqual({
      kind: "interrupted",
      signal: "SIGTERM",
      termination: "sigterm",
      observedExitCode: 143,
    });
    expect(signals).toEqual([15]);
  });

  test("preserves SIGINT before bounded TERM and KILL escalation", async () => {
    let resolveExit!: (exitCode: number) => void;
    const signals: number[] = [];
    const child: RootTestChild = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      kill: (signal = 15) => {
        signals.push(signal);
        if (signal === 15) resolveExit(143);
      },
      unref: () => {},
    };
    let waits = 0;
    const waitWithin: RootTestWaitWithin = async <T>(promise: Promise<T>) => {
      waits += 1;
      if (waits === 2) return { kind: "timeout" };
      return { kind: "settled", value: await promise };
    };

    expect(await superviseRootTestChild(child, {
      interrupted: Promise.resolve("SIGINT"),
      waitWithin,
    })).toEqual({
      kind: "interrupted",
      signal: "SIGINT",
      termination: "sigterm",
      observedExitCode: 143,
    });
    expect(signals).toEqual([2, 15]);
  });

  test("unrefs an unobservable child after every owned kill attempt", async () => {
    const signals: number[] = [];
    let unrefs = 0;
    const child: RootTestChild = {
      exited: new Promise<number>(() => {}),
      kill: (signal = 15) => {
        signals.push(signal);
        throw new Error("kill observer failed");
      },
      unref: () => { unrefs += 1; },
    };
    const alwaysTimeout: RootTestWaitWithin = async () => ({ kind: "timeout" });

    expect(await superviseRootTestChild(child, {
      timeoutMs: 300_000,
      shutdownGraceMs: 5_000,
      waitWithin: alwaysTimeout,
    })).toEqual({
      kind: "timed-out",
      termination: "unobserved",
      observedExitCode: null,
    });
    expect(signals).toEqual([15, 9]);
    expect(unrefs).toBe(1);
    expect(rootTestRequiresForcedExit(124)).toBeTrue();
    expect(rootTestRequiresForcedExit(130)).toBeTrue();
    expect(rootTestRequiresForcedExit(143)).toBeTrue();
    expect(rootTestRequiresForcedExit(1)).toBeFalse();
  });

  test("renders the exact timed-out file and bounded cleanup result", () => {
    expect(ROOT_TEST_FILE_TIMEOUT_MS).toBe(300_000);
    expect(ROOT_TEST_TIMEOUT_EXIT_CODE).toBe(124);
    expect(rootTestTimeoutDiagnostic({
      area: "product",
      file: "tests/product/product-host.test.ts",
      completedFiles: 211,
      totalFiles: 440,
      termination: "sigkill",
    })).toBe(
      "root tests · product timed out · tests/product/product-host.test.ts · exceeded "
        + "300000ms · cleanup sigkill · 211/440 files completed",
    );
  });

  test("the live inventory is a lossless, duplicate-free plan", async () => {
    const discovered = await discoverRootTestFiles(REPO_ROOT);
    const plan = createRootTestPlan(discovered);
    const planned = plan.flatMap((area) => area.files);

    expect(discovered.length).toBeGreaterThan(400);
    expect(new Set(discovered).size).toBe(discovered.length);
    expect(new Set(planned)).toEqual(new Set(discovered));
    expect(planned.length).toBe(discovered.length);
    expect(discovered).toContain("tests/scripts/test-root.test.ts");
    expect(discovered).toContain("tests/integration/root-test-gate.test.ts");
  });
});
