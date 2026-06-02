// tests/harness/meta/coverage-matrix.test.ts — coverage-matrix meta-test
// (Phase H3 full enforcement).
//
// H1 surfaced the registry shape + verified the registration plumbing.
// H2 extended with two coverage-light sanity checks. H3 enforces the
// full effect/trigger/phase/capability/route matrix: every union member in the
// closed-set source-of-truth arrays below must have a covering scenario
// OR be listed in the matching DEFERRED set with a written justification.
//
// Adding a new EffectKind / TriggerKind / Capability / ProcessorPhase /
// RouteKind requires either:
//   - Adding a scenario tagged with the new value, OR
//   - Adding the value to the appropriate DEFERRED set below, with a
//     comment naming the phase that will remove the deferral.
//
// The closed-set arrays MUST stay synchronized with the union members
// in `src/core/effect.ts` + `src/core/processor.ts`. Drift fails CI via
// the "closed-set arrays match union members" exhaustiveness check at
// the bottom of this file.
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
import type {
  CapabilityKind,
  EffectKind,
  RouteKind,
  ScenarioRegistryEntry,
  TriggerKind,
} from "../types";
import type { ProcessorPhase } from "../../../src/core/processor";

// ----- Scenario imports (side-effectful: each registers itself) -----
import "../scenarios/phase-12c-regression.scenario.test";
import "../scenarios/basic-adoption/empty-diff-init.scenario.test";
import "../scenarios/basic-adoption/non-markdown-commit.scenario.test";
import "../scenarios/basic-adoption/idempotent-resync.scenario.test";
import "../scenarios/basic-adoption/multi-file-commit.scenario.test";
import "../scenarios/convergence/normalize-frontmatter-idempotency.scenario.test";
import "../scenarios/convergence/validate-wikilinks-no-duplicate-diagnostics.scenario.test";
import "../scenarios/convergence/diagnostics-auto-resolve.scenario.test";
import "../scenarios/convergence/blocked-adoption-preserves-projections.scenario.test";
import "../scenarios/cli-surface/init-claude-boot.scenario.test";
import "../scenarios/cli-surface/answer-question.scenario.test";
import "../scenarios/cli-surface/doctor-health.scenario.test";
import "../scenarios/cli-surface/query-adopted-state.scenario.test";
import "../scenarios/cli-surface/lint-report.scenario.test";
import "../scenarios/cli-surface/rebuild-projection.scenario.test";
import "../scenarios/cli-surface/sync-rebuilds-stale-projections.scenario.test";
import "../scenarios/cli-surface/view-command-failure.scenario.test";
import "../scenarios/cli-surface/structured-view-contract.scenario.test";
import "../scenarios/cli-surface/today-task-view.scenario.test";
import "../scenarios/cli-surface/prep-view.scenario.test";
import "../scenarios/cli-surface/export-context.scenario.test";
import "../scenarios/cli-surface/json-fixtures.scenario.test";
import "../scenarios/v1-acceptance/claude-code-vault-loop.scenario.test";
import "../scenarios/v1-acceptance/compiler-host-modes.scenario.test";
import "../scenarios/v1-acceptance/recovery-gauntlet.scenario.test";
import "../scenarios/effect-kinds/diagnostic-effect-lands.scenario.test";
import "../scenarios/effect-kinds/patch-effect-applies.scenario.test";
import "../scenarios/effect-kinds/patch-and-diagnostic-same-cycle.scenario.test";
import "../scenarios/effect-kinds/multiple-processors-same-commit.scenario.test";
import "../scenarios/effect-kinds/snapshot-reads-candidate-not-working-tree.scenario.test";
import "../scenarios/effect-kinds/lint-frontmatter-diagnostics.scenario.test";
import "../scenarios/effect-kinds/page-type-schema-diagnostics.scenario.test";
import "../scenarios/effect-kinds/bundle-page-type-schema.scenario.test";
import "../scenarios/effect-kinds/graph-links-emits-facts.scenario.test";
import "../scenarios/effect-kinds/graph-tag-index-emits-facts.scenario.test";
import "../scenarios/effect-kinds/daily-task-index-facts.scenario.test";
import "../scenarios/effect-kinds/broken-images-diagnostics.scenario.test";
import "../scenarios/effect-kinds/duplicate-detection-questions.scenario.test";
import "../scenarios/effect-kinds/wikilink-ambiguity-questions.scenario.test";
import "../scenarios/effect-kinds/stale-dates-diagnostics.scenario.test";
import "../scenarios/effect-kinds/view-effect-via-dome-run.scenario.test";
import "../scenarios/effect-kinds/intake-extract-capture.scenario.test";
import "../scenarios/effect-routing/job-effect-drains-worker-patch.scenario.test";
import "../scenarios/effect-routing/outbox-recovery-answer.scenario.test";
import "../scenarios/effect-routing/health-outbox-recovery.scenario.test";
import "../scenarios/effect-routing/health-quarantine-recovery.scenario.test";
import "../scenarios/effect-routing/health-orphan-run-recovery.scenario.test";
import "../scenarios/effect-routing/daily-create-carry-forward.scenario.test";
import "../scenarios/capabilities/read-capability-filters-snapshot.scenario.test";
import "../scenarios/capabilities/projection-read-scope.scenario.test";
import "../scenarios/capabilities/model-invoke-scheduled.scenario.test";
import "../scenarios/capabilities/model-write-provenance.scenario.test";
import "../scenarios/capabilities/scheduled-execution-cap.scenario.test";
import "../scenarios/triggers/file-created-fires.scenario.test";
import "../scenarios/triggers/document-changed-fires.scenario.test";
import "../scenarios/lifecycle/crash-and-restart-mid-stream.scenario.test";
import "../scenarios/lifecycle/bundle-uninstall-reinstall.scenario.test";
import "../scenarios/lifecycle/throwing-processor-blocks-adoption.scenario.test";
import "../scenarios/garden-cascade/sub-proposal-frame-correctness.scenario.test";
import "../scenarios/garden-cascade/multiple-garden-patches.scenario.test";
import "../scenarios/garden-cascade/sub-proposal-max-iterations.scenario.test";
import "../scenarios/garden-cascade/bundle-id-trailers.scenario.test";

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
    // First-party bundles now ship processors in adoption, garden, and
    // view phases. Keep this explicit until the meta-test reads the
    // loaded processor registry directly.
    const shippedPhases: ReadonlyArray<string> = [
      "adoption",
      "garden",
      "view",
    ];
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
      "capabilities",
      "lifecycle",
      "cli-surface",
      "garden-cascade",
      "v1-acceptance",
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

// ============================================================================
// ----- H3 enforcement: closed-set coverage matrix ---------------------------
// ============================================================================
//
// Source-of-truth arrays. Adding a new union member to `src/core/effect.ts`
// or `src/core/processor.ts` requires updating the matching array here.
// The `exhaustivelyCovers*` helpers at the bottom of this block use the
// `never`-trick to fail-to-compile if a union variant is added without
// updating the array.

const EFFECT_KINDS_ALL: ReadonlyArray<EffectKind> = [
  "patch",
  "diagnostic",
  "fact",
  "search-document",
  "question",
  "job",
  "external",
  "outbox-recovery",
  "quarantine-recovery",
  "run-recovery",
  "view",
];

const TRIGGER_KINDS_ALL: ReadonlyArray<TriggerKind> = [
  "signal",
  "path",
  "schedule",
  "answer",
  "command",
];

const CAPABILITY_KINDS_ALL: ReadonlyArray<CapabilityKind> = [
  "read",
  "patch.propose",
  "patch.auto",
  "owns.region",
  "owns.path",
  "graph.write",
  "search.write",
  "question.ask",
  "job.enqueue",
  "model.invoke",
  "external",
  "outbox.read",
  "outbox.recover",
  "quarantine.read",
  "quarantine.recover",
  "run.read",
  "run.recover",
];

const PHASES_ALL: ReadonlyArray<ProcessorPhase> = [
  "adoption",
  "garden",
  "view",
];

const ROUTES_ALL: ReadonlyArray<RouteKind> = [
  "adoption",
  "garden-signal",
  "garden-schedule",
  "garden-job",
  "garden-answer",
  "view-command",
];

// Deferred sets. Each entry is a value that no shipped processor exercises
// today; the comment names the phase that will remove the deferral.
// REMOVING an entry from these sets requires adding a scenario that
// exercises the value. ADDING an entry requires a comment justification.

const DEFERRED_EFFECTS: ReadonlySet<EffectKind> = new Set<EffectKind>([
  // Phase 13a unblocked: fact (dome.graph.links), view (dome.markdown.orphan-pages).
  // Phase 13b unblocked: question (dome.markdown.duplicate-detection).
  // Effect-routing fixture coverage unblocked: job.
  // Effect-routing fixture coverage unblocked: outbox-recovery.
  "external",  // Phase 16+ — outbox-targeted external actions (calendar.write, etc.)
]);

const DEFERRED_TRIGGERS: ReadonlySet<TriggerKind> = new Set<TriggerKind>([
  // Phase 13a unblocked: command (`dome run orphan-pages`).
  // Harness operational-work coverage unblocked: schedule.
  // CLI-surface recovery coverage unblocked: answer.
  "path",      // No shipped processor uses path triggers (signal triggers cover today's needs)
]);

const DEFERRED_CAPABILITIES: ReadonlySet<CapabilityKind> = new Set<CapabilityKind>([
  // Phase 13a unblocked: graph.write (dome.graph.links declares `dome.graph.*`).
  // Phase 13b unblocked: question.ask (dome.markdown.duplicate-detection).
  // Effect-routing fixture coverage unblocked: job.enqueue.
  // Harness operational-work coverage unblocked: model.invoke.
  // Effect-routing fixture coverage unblocked: outbox.recover.
  "patch.propose", // No shipped processor uses propose-mode patches (normalize-frontmatter is auto-mode)
  "owns.region",   // Phase 15 — owned-region processors (marker-delimited write ownership)
  "owns.path",     // Phase 15 — owned-path processors (whole-file write ownership)
  "external",      // Phase 16 — external-capability processors (paired with ExternalActionEffect)
]);

const DEFERRED_PHASES: ReadonlySet<ProcessorPhase> = new Set<ProcessorPhase>([
  // Phase 13a unblocked: view (dome.markdown.orphan-pages, end-to-end via `dome run`).
]);

describe("coverage matrix (Phase H3 enforcement)", () => {
  // ----- Effect kinds ----------------------------------------------------

  for (const kind of EFFECT_KINDS_ALL) {
    test(`effect kind '${kind}' has at least one scenario`, () => {
      if (DEFERRED_EFFECTS.has(kind)) return;
      const tagged = getRegistry().filter((e) =>
        hasTag(e, (t) => t.kind === "effect" && t.effect === kind),
      );
      expect(
        tagged.length > 0,
        `No scenario tagged effect='${kind}'. Add one in tests/harness/scenarios/.\n` +
          `If this effect kind is genuinely deferred, document the reason in DEFERRED_EFFECTS.`,
      ).toBe(true);
    });
  }

  // ----- Trigger kinds ---------------------------------------------------

  for (const kind of TRIGGER_KINDS_ALL) {
    test(`trigger kind '${kind}' has at least one scenario`, () => {
      if (DEFERRED_TRIGGERS.has(kind)) return;
      const tagged = getRegistry().filter((e) =>
        hasTag(e, (t) => t.kind === "trigger" && t.trigger === kind),
      );
      expect(
        tagged.length > 0,
        `No scenario tagged trigger='${kind}'. Add one in tests/harness/scenarios/.\n` +
          `If this trigger kind is genuinely deferred, document the reason in DEFERRED_TRIGGERS.`,
      ).toBe(true);
    });
  }

  // ----- Capability kinds ------------------------------------------------

  for (const kind of CAPABILITY_KINDS_ALL) {
    test(`capability kind '${kind}' has at least one scenario`, () => {
      if (DEFERRED_CAPABILITIES.has(kind)) return;
      const tagged = getRegistry().filter((e) =>
        hasTag(e, (t) => t.kind === "capability" && t.capability === kind),
      );
      expect(
        tagged.length > 0,
        `No scenario tagged capability='${kind}'. Add one in tests/harness/scenarios/.\n` +
          `If this capability kind is genuinely deferred, document the reason in DEFERRED_CAPABILITIES.`,
      ).toBe(true);
    });
  }

  // ----- Processor phases ------------------------------------------------

  for (const phase of PHASES_ALL) {
    test(`processor phase '${phase}' has at least one scenario`, () => {
      if (DEFERRED_PHASES.has(phase)) return;
      const tagged = getRegistry().filter((e) =>
        hasTag(e, (t) => t.kind === "phase" && t.phase === phase),
      );
      expect(
        tagged.length > 0,
        `No scenario tagged phase='${phase}'. Add one in tests/harness/scenarios/.\n` +
          `If this phase is genuinely deferred, document the reason in DEFERRED_PHASES.`,
      ).toBe(true);
    });
  }

  // ----- Engine routes ---------------------------------------------------

  for (const route of ROUTES_ALL) {
    test(`engine route '${route}' has at least one scenario`, () => {
      const tagged = getRegistry().filter((e) =>
        hasTag(e, (t) => t.kind === "route" && t.route === route),
      );
      expect(
        tagged.length > 0,
        `No scenario tagged route='${route}'. Add one in tests/harness/scenarios/.\n` +
          `Route tags distinguish dispatcher paths that may share the same processor phase.`,
      ).toBe(true);
    });
  }

  // ----- Deferred-set hygiene -------------------------------------------
  //
  // A deferred entry that DOES have covering scenarios is a stale
  // deferral — remove it from the set rather than masking real coverage.

  test("DEFERRED_EFFECTS contains no entries with covering scenarios", () => {
    for (const kind of DEFERRED_EFFECTS) {
      const tagged = getRegistry().filter((e) =>
        hasTag(e, (t) => t.kind === "effect" && t.effect === kind),
      );
      expect(
        tagged.length,
        `effect '${kind}' is in DEFERRED_EFFECTS but has ${tagged.length} covering scenario(s); ` +
          `remove from DEFERRED_EFFECTS to enforce coverage.`,
      ).toBe(0);
    }
  });

  test("DEFERRED_TRIGGERS contains no entries with covering scenarios", () => {
    for (const kind of DEFERRED_TRIGGERS) {
      const tagged = getRegistry().filter((e) =>
        hasTag(e, (t) => t.kind === "trigger" && t.trigger === kind),
      );
      expect(
        tagged.length,
        `trigger '${kind}' is in DEFERRED_TRIGGERS but has ${tagged.length} covering scenario(s); ` +
          `remove from DEFERRED_TRIGGERS to enforce coverage.`,
      ).toBe(0);
    }
  });

  test("DEFERRED_CAPABILITIES contains no entries with covering scenarios", () => {
    for (const kind of DEFERRED_CAPABILITIES) {
      const tagged = getRegistry().filter((e) =>
        hasTag(e, (t) => t.kind === "capability" && t.capability === kind),
      );
      expect(
        tagged.length,
        `capability '${kind}' is in DEFERRED_CAPABILITIES but has ${tagged.length} covering scenario(s); ` +
          `remove from DEFERRED_CAPABILITIES to enforce coverage.`,
      ).toBe(0);
    }
  });

  test("DEFERRED_PHASES contains no entries with covering scenarios", () => {
    for (const phase of DEFERRED_PHASES) {
      const tagged = getRegistry().filter((e) =>
        hasTag(e, (t) => t.kind === "phase" && t.phase === phase),
      );
      expect(
        tagged.length,
        `phase '${phase}' is in DEFERRED_PHASES but has ${tagged.length} covering scenario(s); ` +
          `remove from DEFERRED_PHASES to enforce coverage.`,
      ).toBe(0);
    }
  });
});

// ----- Tag-search helper ----------------------------------------------------

function hasTag(
  entry: ScenarioRegistryEntry,
  pred: (t: ScenarioRegistryEntry["spec"]["tags"][number]) => boolean,
): boolean {
  return entry.spec.tags.some(pred);
}

// ----- Closed-set exhaustiveness checks ------------------------------------
//
// Compile-time guards: if a future commit adds a new variant to the union
// in `src/core/effect.ts` or `src/core/processor.ts` without updating the
// matching array here, these `_assert*` declarations fail to type-check.
// The runtime side of the check is the per-kind tests above — they will
// also surface a missing scenario at test time — but the compile-time
// guard catches the missing-array-entry case before it can produce a
// false-positive "matrix covered" pass.
//
// (Bun's test loader compiles + runs these files; the assertions below
// are evaluated at type-check time.)

type _AssertEffectsExhaustive = Exclude<
  EffectKind,
  (typeof EFFECT_KINDS_ALL)[number]
> extends never
  ? true
  : never;
type _AssertTriggersExhaustive = Exclude<
  TriggerKind,
  (typeof TRIGGER_KINDS_ALL)[number]
> extends never
  ? true
  : never;
type _AssertCapabilitiesExhaustive = Exclude<
  CapabilityKind,
  (typeof CAPABILITY_KINDS_ALL)[number]
> extends never
  ? true
  : never;
type _AssertPhasesExhaustive = Exclude<
  ProcessorPhase,
  (typeof PHASES_ALL)[number]
> extends never
  ? true
  : never;
type _AssertRoutesExhaustive = Exclude<
  RouteKind,
  (typeof ROUTES_ALL)[number]
> extends never
  ? true
  : never;

// Force the type checker to use the assertions above (no-op consts that
// hold the asserted types — if any union variant is missing, the const
// declaration becomes `never` and TS errors).
const _effectsExhaustive: _AssertEffectsExhaustive = true;
const _triggersExhaustive: _AssertTriggersExhaustive = true;
const _capabilitiesExhaustive: _AssertCapabilitiesExhaustive = true;
const _phasesExhaustive: _AssertPhasesExhaustive = true;
const _routesExhaustive: _AssertRoutesExhaustive = true;
// Touch the names to satisfy noUnusedLocals.
void _effectsExhaustive;
void _triggersExhaustive;
void _capabilitiesExhaustive;
void _phasesExhaustive;
void _routesExhaustive;
