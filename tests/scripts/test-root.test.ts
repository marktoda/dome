import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  createRootTestPlan,
  discoverRootTestFiles,
  ROOT_TEST_AREA_ORDER,
  rootTestCommand,
  rootTestSignalExitCode,
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
