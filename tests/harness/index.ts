// tests/harness/index.ts — the `scenario(...)` wrapper + module-scoped
// registry + public surface.
//
// Importing `scenario` and calling it at module top-level registers the
// scenario into the in-memory registry and normally wraps the body in a
// `bun:test` `test()` call that constructs a fresh Harness, runs the body, and
// cleans up — including on throw. The isolated coverage collector enables
// catalog-only mode before importing scenarios, so it records metadata without
// installing duplicate executable tests.
//
// The registry is module-scoped: the catalog collector reads it after importing
// every `*.scenario.test.ts` file, then sends the metadata to the matrix test.

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
let catalogOnly = false;

/**
 * Collect scenario metadata without installing Bun test bodies. This switch is
 * module-local and must be enabled before scenario modules load; the coverage
 * collector uses it in an isolated child process.
 */
export function enableScenarioCatalogOnlyMode(): void {
  if (SCENARIO_REGISTRY.length > 0) {
    throw new Error("scenario catalog-only mode must be enabled before registration");
  }
  catalogOnly = true;
}

/**
 * Register a scenario and wrap it as a `bun:test` `test()` call.
 *
 * The body receives a fresh Harness. Cleanup runs in a `finally` so the
 * tmpdir + open DB handles are released even when the body throws.
 */
export function scenario(spec: ScenarioSpec, body: ScenarioBody): void {
  SCENARIO_REGISTRY.push({ spec });
  if (catalogOnly) return;

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

/** Read-only access to the registry; consumed by the isolated catalog collector. */
export function getRegistry(): ReadonlyArray<ScenarioRegistryEntry> {
  return SCENARIO_REGISTRY;
}

export { HarnessImpl } from "./harness";
export { TestClock } from "./test-clock";
export * from "./types";
