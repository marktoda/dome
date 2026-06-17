// Registry-orphan GC (v1 chunk 11, Task 4a).
//
// Execution-state counters (the quarantined.json entries) for a processor
// whose bundle is no longer registered (retired/uninstalled) are dead weight
// that never gets cleaned up — the stale dome.intake.synthesize-rollup
// sub-threshold counter that lived forever. `pruneUnknownProcessors` GCs them,
// but MUST NOT prune a registered-but-DISABLED processor's counter (the bundle
// still ships; it is just turned off, and re-enabling it should find its
// failure history intact). The caller supplies an `isKnownProcessor` predicate
// derived from the FULL installed registry (enabled + disabled), not the
// policy-filtered enabled-only one.

import { describe, expect, test } from "bun:test";

import {
  buildProcessorExecutionState,
  type ProcessorExecutionStateEntry,
} from "../../src/processors/execution-state";

function entry(
  processorId: string,
  over?: Partial<ProcessorExecutionStateEntry>,
): ProcessorExecutionStateEntry {
  return Object.freeze({
    phase: "garden" as const,
    processorId,
    processorVersion: "0.1.0",
    triggerHash: `hash-${processorId}`,
    consecutiveRetryableFailures: 2,
    ...over,
  });
}

describe("pruneUnknownProcessors", () => {
  test("prunes a counter for an unregistered (retired) bundle", () => {
    let persisted: ReadonlyArray<ProcessorExecutionStateEntry> | null = null;
    const state = buildProcessorExecutionState({
      initialEntries: [entry("dome.intake.synthesize-rollup")],
      onEntriesChanged: (entries) => {
        persisted = entries;
      },
    });

    const removed = state.pruneUnknownProcessors(() => false);
    expect(removed).toBe(1);
    // Persisted with the entry gone.
    expect(persisted).not.toBeNull();
    expect((persisted ?? []).length).toBe(0);
  });

  test("preserves a registered-but-disabled processor's counter", () => {
    let persisted: ReadonlyArray<ProcessorExecutionStateEntry> | null = null;
    const state = buildProcessorExecutionState({
      initialEntries: [entry("dome.markdown.lint-supersession")],
      onEntriesChanged: (entries) => {
        persisted = entries;
      },
    });

    // The bundle is installed (known) even though disabled by policy → keep.
    const removed = state.pruneUnknownProcessors(
      (id) => id === "dome.markdown.lint-supersession",
    );
    expect(removed).toBe(0);
    // No mutation → no persist call.
    expect(persisted).toBeNull();
  });

  test("prunes only the unknown entries in a mixed set", () => {
    const state = buildProcessorExecutionState({
      initialEntries: [
        entry("dome.markdown.lint-supersession"),
        entry("retired.bundle.processor"),
        entry("dome.health.outbox-recovery-questions"),
      ],
    });
    const known = new Set([
      "dome.markdown.lint-supersession",
      "dome.health.outbox-recovery-questions",
    ]);
    const removed = state.pruneUnknownProcessors((id) => known.has(id));
    expect(removed).toBe(1);
    expect(
      state.quarantines().map((q) => q.key.processorId).sort(),
    ).not.toContain("retired.bundle.processor");
  });

  test("a quarantined counter for an unknown bundle is pruned (not surfaced as a finding forever)", () => {
    const state = buildProcessorExecutionState({
      quarantineThreshold: 1,
      initialEntries: [
        entry("retired.bundle.processor", {
          consecutiveRetryableFailures: 3,
          quarantineId: "q-1",
          quarantinedAt: new Date("2026-01-01T00:00:00.000Z"),
          reason: "old failure",
        }),
      ],
    });
    expect(state.quarantines().length).toBe(1);
    const removed = state.pruneUnknownProcessors(() => false);
    expect(removed).toBe(1);
    expect(state.quarantines().length).toBe(0);
  });
});
