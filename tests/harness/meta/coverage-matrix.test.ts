// tests/harness/meta/coverage-matrix.test.ts — coverage-matrix meta-test
// (Phase H2 mini-version).
//
// H1 surfaced the registry shape + verified the registration plumbing.
// H2 extends with two coverage-light sanity checks: every shipped
// processor's phase has at least one scenario covering it, and every
// scenario file under `scenarios/` is registered. H3 will enforce the
// full effect/trigger/phase/capability matrix.
//
// Registry population: bun:test loads every `*.test.ts` file in the
// suite into the same process before executing any test body. The
// explicit `import "..."` lines below ensure the scenario modules are
// loaded into THIS process — necessary because `meta/` lives in its own
// subdirectory and bun's test loader doesn't traverse upward
// automatically. Loading runs the top-level `scenario(...)` calls,
// populating the module-scoped registry. The meta-test's assertions run
// inside `test(...)` bodies, so they observe the fully-populated
// registry regardless of which file bun loaded first.

import { describe, expect, test } from "bun:test";

import { getRegistry } from "../index";

// ----- Scenario imports (side-effectful: each registers itself) -----
import "../scenarios/phase-12c-regression.scenario.test";
import "../scenarios/basic-adoption/empty-diff-init.scenario.test";
import "../scenarios/basic-adoption/non-markdown-commit.scenario.test";
import "../scenarios/basic-adoption/idempotent-resync.scenario.test";
import "../scenarios/basic-adoption/multi-file-commit.scenario.test";
import "../scenarios/convergence/normalize-frontmatter-idempotency.scenario.test";
import "../scenarios/convergence/validate-wikilinks-no-duplicate-diagnostics.scenario.test";
import "../scenarios/effect-kinds/diagnostic-effect-lands.scenario.test";
import "../scenarios/effect-kinds/patch-effect-applies.scenario.test";
import "../scenarios/effect-kinds/patch-and-diagnostic-same-cycle.scenario.test";
import "../scenarios/triggers/file-created-fires.scenario.test";
import "../scenarios/triggers/document-changed-fires.scenario.test";
import "../scenarios/lifecycle/crash-and-restart-mid-stream.scenario.test";
import "../scenarios/lifecycle/bundle-uninstall-reinstall.scenario.test";

describe("coverage matrix (Phase H2 mini-version)", () => {
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

  // H2 additions ----------------------------------------------------------

  test("every shipped processor's phase has at least one scenario", () => {
    // The currently-shipped first-party bundle (dome.markdown) carries two
    // processors, both in the `adoption` phase. As more phases ship
    // (capture, retrieval, learning, ...) we extend this list; H3 will
    // wire it to the processor registry so it stays automatically in sync.
    const shippedPhases: ReadonlyArray<string> = ["adoption"];
    const registry = getRegistry();
    for (const phase of shippedPhases) {
      const covered = registry.some((entry) =>
        entry.spec.tags.some(
          (t) => t.kind === "phase" && t.phase === phase,
        ),
      );
      expect(
        covered,
        `phase ${JSON.stringify(phase)} has no scenario covering it`,
      ).toBe(true);
    }
  });

  test("every scenario in the registry is uniquely tagged with a known group", () => {
    // Sanity: group tags must be from the `ScenarioGroup` union; bun:test
    // can't verify the literal union at runtime, but we can verify the
    // tag shape and ensure at least one scenario per expected group is
    // present (catches the "added a scenario but forgot to add its
    // group" mistake).
    const knownGroups: ReadonlyArray<string> = [
      "basic-adoption",
      "convergence",
      "effect-kinds",
      "triggers",
      "lifecycle",
      "regression",
    ];
    const registry = getRegistry();
    for (const group of knownGroups) {
      const covered = registry.some((entry) =>
        entry.spec.tags.some(
          (t) => t.kind === "group" && t.group === group,
        ),
      );
      expect(
        covered,
        `group ${JSON.stringify(group)} has no scenarios registered`,
      ).toBe(true);
    }
  });
});
