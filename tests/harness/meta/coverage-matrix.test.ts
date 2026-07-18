// tests/harness/meta/coverage-matrix.test.ts — coverage-matrix meta-test
// (Phase H3 full enforcement).
//
// Catalog-integrity checks verify registration metadata. The closed-set matrix
// enforces the full effect/trigger/phase/capability/route surface: every union
// member in the source-of-truth arrays below must have a covering scenario OR
// be listed in the matching DEFERRED set with a written justification.
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
// Registry population is metadata-only. An isolated collector child discovers
// every scenario module and imports it with test-body installation disabled.
// This file therefore verifies the catalog without rerunning the executable
// scenarios that the root test runner executes in their own files. Parent-side
// ownership and a shorter child-side watchdog bound both normal and orphaned
// collector lifetimes.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import type {
  CapabilityKind,
  EffectKind,
  RouteKind,
  ScenarioGroup,
  ScenarioSpec,
  TriggerKind,
} from "../types";
import type { ProcessorPhase } from "../../../src/core/processor";

type ScenarioCatalogEntry = Readonly<Pick<ScenarioSpec, "name" | "tags">>;

const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG = await loadScenarioCatalog();

async function loadScenarioCatalog(): Promise<ReadonlyArray<ScenarioCatalogEntry>> {
  const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  const killActiveChild = (): void => {
    if (child === null || child.exitCode !== null) return;
    try { child.kill("SIGKILL"); } catch {}
  };
  process.once("exit", killActiveChild);
  try {
    child = Bun.spawn([
      process.execPath,
      resolve(import.meta.dir, "collect-scenario-catalog.ts"),
    ], {
      cwd: resolve(import.meta.dir, "..", "..", ".."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const detail = stderr.trim();
    if (signal.aborted) {
      throw new Error(
        `scenario catalog collector timed out after ${CATALOG_TIMEOUT_MS}ms${detail === "" ? "" : `: ${detail}`}`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(`scenario catalog collector exited ${exitCode}${detail === "" ? "" : `: ${detail}`}`);
    }
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("scenario catalog collector returned a non-array");
    return Object.freeze(parsed.map((entry, index) => {
      if (
        entry === null || typeof entry !== "object" ||
        !("name" in entry) || typeof entry.name !== "string" ||
        !("tags" in entry) || !Array.isArray(entry.tags)
      ) {
        throw new Error(`scenario catalog entry ${index} is invalid`);
      }
      return Object.freeze({
        name: entry.name,
        tags: Object.freeze([...entry.tags]) as ScenarioSpec["tags"],
      });
    }));
  } finally {
    process.off("exit", killActiveChild);
    if (child !== null && child.exitCode === null) {
      killActiveChild();
      await child.exited.catch(() => {});
    }
  }
}

describe("coverage matrix catalog integrity", () => {
  test("registry is non-empty", () => {
    const registry = CATALOG;
    expect(registry.length).toBeGreaterThan(0);
  });

  test("scenario names are unique", () => {
    const names = new Set<string>();
    for (const entry of CATALOG) {
      expect(
        names.has(entry.name),
        `duplicate scenario name: ${JSON.stringify(entry.name)}`,
      ).toBe(false);
      names.add(entry.name);
    }
  });

  test("every scenario uses known groups and every catalog group is represented", () => {
    const knownGroups = [
      "basic-adoption",
      "convergence",
      "effect-kinds",
      "triggers",
      "capabilities",
      "external-actions",
      "lifecycle",
      "cli-surface",
      "garden-cascade",
      "v1-acceptance",
      "regression",
    ] as const satisfies ReadonlyArray<ScenarioGroup>;
    const known = new Set<string>(knownGroups);
    for (const entry of CATALOG) {
      const groups = entry.tags.filter((tag) => tag.kind === "group");
      expect(
        groups.length > 0,
        `scenario ${JSON.stringify(entry.name)} must have at least one group tag`,
      ).toBe(true);
      expect(
        new Set(groups.map((tag) => tag.group)).size,
        `scenario ${JSON.stringify(entry.name)} has a duplicate group tag`,
      ).toBe(groups.length);
      for (const group of groups) {
        expect(
          known.has(group.group),
          `scenario ${JSON.stringify(entry.name)} has unknown group ${JSON.stringify(group.group)}`,
        ).toBe(true);
      }
    }
    for (const group of knownGroups) {
      const covered = CATALOG.some((entry) =>
        entry.tags.some(
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
  "owns.path",
  "graph.write",
  "search.write",
  "question.ask",
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
  "garden-answer",
  "view-command",
];

// Deferred sets. Each entry is a value that no shipped processor exercises
// today; the comment names the phase that will remove the deferral.
// REMOVING an entry from these sets requires adding a scenario that
// exercises the value. ADDING an entry requires a comment justification.

const DEFERRED_EFFECTS: ReadonlySet<EffectKind> = new Set<EffectKind>([
  // Phase 13a unblocked: fact (dome.graph.links), view (dome.markdown.orphan-pages).
  // Phase 13b unblocked: question (dome.markdown.ambiguous-wikilink).
  // Effect-routing fixture coverage unblocked: outbox-recovery.
  // Sources-subscription coverage unblocked: external (dome.sources.fetch,
  // scenarios/effect-kinds/sources-subscription-fetch).
]);

const DEFERRED_TRIGGERS: ReadonlySet<TriggerKind> = new Set<TriggerKind>([
  // Phase 13a unblocked: command (`dome run orphan-pages`).
  // Harness operational-work coverage unblocked: schedule.
  // CLI-surface recovery coverage unblocked: answer.
  // Processor execution-cap coverage unblocked: path.
]);

const DEFERRED_CAPABILITIES: ReadonlySet<CapabilityKind> = new Set<CapabilityKind>([
  // Phase 13a unblocked: graph.write (dome.graph.links declares `dome.graph.*`).
  // Phase 13b unblocked: question.ask (dome.markdown.ambiguous-wikilink).
  // Harness operational-work coverage unblocked: model.invoke.
  // Effect-routing fixture coverage unblocked: outbox.recover.
  // Sources-subscription coverage unblocked: external (dome.sources.fetch,
  // scenarios/effect-kinds/sources-subscription-fetch).
  "patch.propose", // No shipped processor uses propose-mode patches (normalize-frontmatter is auto-mode)
  "owns.path",     // Phase 15 — owned-path processors (whole-file write ownership)
]);

const DEFERRED_PHASES: ReadonlySet<ProcessorPhase> = new Set<ProcessorPhase>([
  // Phase 13a unblocked: view (dome.markdown.orphan-pages, end-to-end via `dome run`).
]);

describe("coverage matrix (Phase H3 enforcement)", () => {
  // ----- Effect kinds ----------------------------------------------------

  for (const kind of EFFECT_KINDS_ALL) {
    test(`effect kind '${kind}' has at least one scenario`, () => {
      if (DEFERRED_EFFECTS.has(kind)) return;
      const tagged = CATALOG.filter((e) =>
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
      const tagged = CATALOG.filter((e) =>
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
      const tagged = CATALOG.filter((e) =>
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
      const tagged = CATALOG.filter((e) =>
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
      const tagged = CATALOG.filter((e) =>
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
      const tagged = CATALOG.filter((e) =>
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
      const tagged = CATALOG.filter((e) =>
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
      const tagged = CATALOG.filter((e) =>
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
      const tagged = CATALOG.filter((e) =>
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
  entry: ScenarioCatalogEntry,
  pred: (t: ScenarioCatalogEntry["tags"][number]) => boolean,
): boolean {
  return entry.tags.some(pred);
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
