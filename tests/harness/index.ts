// tests/harness/index.ts — the `scenario(...)` wrapper + module-scoped
// registry + public surface.
//
// Importing `scenario` and calling it at module top-level registers the
// scenario into the in-memory registry (for coverage-matrix verification)
// AND wraps the body in a `bun:test` `test()` call that constructs a
// fresh Harness, runs the body, and cleans up — including on throw.
//
// The registry is module-scoped: the coverage-matrix meta-test reads it
// after importing every `*.scenario.test.ts` file. Future phases (H3)
// will assert the matrix; H1 only verifies the registry is populated and
// that every scenario has at least one group tag.

import { test } from "bun:test";

import { HarnessImpl } from "./harness";
import type {
  ScenarioBody,
  ScenarioRegistryEntry,
  ScenarioSpec,
} from "./types";

const DEFAULT_SCENARIO_TIMEOUT_MS = 30_000;

// Module-scoped registry for coverage-matrix verification.
const SCENARIO_REGISTRY: ScenarioRegistryEntry[] = [];

/**
 * Register a scenario and wrap it as a `bun:test` `test()` call.
 *
 * The body receives a fresh Harness. Cleanup runs in a `finally` so the
 * tmpdir + open DB handles are released even when the body throws.
 */
export function scenario(spec: ScenarioSpec, body: ScenarioBody): void {
  SCENARIO_REGISTRY.push({ spec });

  const runner = spec.skip !== undefined ? test.skip : test;
  const handler = async (): Promise<void> => {
    const h = await HarnessImpl.create(spec.harness ?? {});
    try {
      await body(h);
    } finally {
      await h.cleanup();
    }
  };

  runner(spec.name, handler, spec.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS);
}

/** Read-only access to the registry; consumed by the coverage-matrix meta-test. */
export function getRegistry(): ReadonlyArray<ScenarioRegistryEntry> {
  return SCENARIO_REGISTRY;
}

export { HarnessImpl } from "./harness";
export { TestClock } from "./test-clock";
export * from "./types";
