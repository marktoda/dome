import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  createRootTestPlan,
  discoverRootTestFiles,
  ROOT_TEST_PARTITION_ORDER,
  rootTestSignalExitCode,
} from "../../scripts/test-root";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

describe("root test partition runner", () => {
  test("classifies every file once in fixed partition and file order", () => {
    const plan = createRootTestPlan([
      "tests/z-last.test.ts",
      "tests/product/z-product.test.ts",
      "tests/scripts/b-script.test.ts",
      "tests/harness/a-harness.test.ts",
      "tests/scripts/a-script.test.ts",
      "tests/engine/a-runtime.test.ts",
    ]);

    expect(plan.map((partition) => partition.name)).toEqual([...ROOT_TEST_PARTITION_ORDER]);
    expect(plan.map((partition) => partition.files)).toEqual([
      ["tests/scripts/a-script.test.ts", "tests/scripts/b-script.test.ts"],
      ["tests/harness/a-harness.test.ts"],
      ["tests/product/z-product.test.ts"],
      ["tests/engine/a-runtime.test.ts", "tests/z-last.test.ts"],
    ]);
    for (const partition of plan) {
      expect(partition.bunArgs).toEqual(["test", ...partition.files]);
      expect(Object.isFrozen(partition)).toBeTrue();
      expect(Object.isFrozen(partition.files)).toBeTrue();
      expect(Object.isFrozen(partition.bunArgs)).toBeTrue();
    }
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

  test("the live inventory is a lossless, duplicate-free partition", async () => {
    const discovered = await discoverRootTestFiles(REPO_ROOT);
    const plan = createRootTestPlan(discovered);
    const planned = plan.flatMap((partition) => partition.files);

    expect(discovered.length).toBeGreaterThan(400);
    expect(new Set(discovered).size).toBe(discovered.length);
    expect(new Set(planned)).toEqual(new Set(discovered));
    expect(planned.length).toBe(discovered.length);
    expect(discovered).toContain("tests/scripts/test-root.test.ts");
    expect(discovered).toContain("tests/integration/root-test-gate.test.ts");
  });
});
