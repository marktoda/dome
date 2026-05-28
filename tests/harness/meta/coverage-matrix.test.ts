// tests/harness/meta/coverage-matrix.test.ts — coverage-matrix meta-test
// (Phase H3 mini-version).
//
// H1 surfaces the registry shape + verifies the registration plumbing.
// Future phases will iterate `EFFECT_KINDS` / `TRIGGER_KINDS` /
// `PROCESSOR_PHASES` / `CAPABILITY_KINDS` and assert each has at least
// one scenario tagged for it. For H1 we assert:
//
//   1. The registry is non-empty (at least one scenario registered).
//   2. Every registered scenario has at least one `group` tag (so the
//      "categorize new scenarios" contract is enforced from day one).
//   3. Scenario names are unique.
//
// Registry population: bun:test loads every `*.test.ts` file in the
// suite into the same process before executing any test body. Loading
// `scenarios/*.scenario.test.ts` and `self-test.test.ts` runs the
// top-level `scenario(...)` calls, populating the module-scoped
// registry. The meta-test's assertions run inside `test(...)` bodies,
// so they observe the fully-populated registry regardless of which
// file bun loaded first. No side-effect imports needed.

import { describe, expect, test } from "bun:test";

import { getRegistry } from "../index";

describe("coverage matrix (Phase H1 mini-version)", () => {
  test("registry is non-empty", () => {
    const registry = getRegistry();
    expect(registry.length).toBeGreaterThan(0);
  });

  test("every scenario has at least one group tag", () => {
    for (const entry of getRegistry()) {
      const hasGroupTag = entry.spec.tags.some((t) => t.kind === "group");
      expect(
        hasGroupTag,
        `scenario ${JSON.stringify(entry.spec.name)} has no group tag`,
      ).toBe(true);
    }
  });

  test("scenario names are unique", () => {
    const names = new Set<string>();
    for (const entry of getRegistry()) {
      expect(
        names.has(entry.spec.name),
        `duplicate scenario name: ${JSON.stringify(entry.spec.name)}`,
      ).toBe(false);
      names.add(entry.spec.name);
    }
  });
});
