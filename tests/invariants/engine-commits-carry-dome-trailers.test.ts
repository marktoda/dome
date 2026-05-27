import { describe, test } from "bun:test";

/**
 * AC3 lockstep for ENGINE_COMMITS_CARRY_DOME_TRAILERS — off-matrix. Per
 * docs/wiki/specs/sdk-surface.md §"Off-matrix lockstep convention", the
 * lockstep file delegates to the canonical structural-enforcement test
 * rather than carrying a no-op stub. A regression in the linked test fails
 * the lockstep transitively.
 *
 * Enforcement test: tests/integration/workflow-atomic-commit.test.ts (the
 * existing per-workflow-atomic-commit test is extended to assert the four
 * Dome-* trailers parse out of every workflow-driven commit).
 */
describe("ENGINE_COMMITS_CARRY_DOME_TRAILERS (off-matrix)", () => {
  test("enforced by tests/integration/workflow-atomic-commit.test.ts (trailer parse)", async () => {
    await import("../integration/workflow-atomic-commit.test");
  });
});
