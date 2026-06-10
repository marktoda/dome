import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIRST_PARTY_MAINTENANCE_LOOPS,
  validateMaintenanceLoops,
} from "../../src/extensions/maintenance-loops";
import {
  DEDICATED_VIEW_COMMAND_ALIASES,
  publicViewCommandName,
} from "../../src/cli/view-command-aliases";
import {
  flattenBundleProcessors,
  loadBundles,
} from "../../src/extensions/loader";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");
const EXEMPT_FIRST_PARTY_PROCESSORS = new Set([
  // Read-only report surface; it explains diagnostics but does not maintain a
  // desired state itself.
  "dome.lint.report",
]);

describe("first-party maintenance loops", () => {
  test("declare the nine first-party loop design units", () => {
    expect(FIRST_PARTY_MAINTENANCE_LOOPS.map((loop) => loop.id)).toEqual([
      "dome.capture.digest",
      "dome.open-loop.continuity",
      "dome.link-concept.coherence",
      "dome.context.packet",
      "dome.claim.coherence",
      "dome.question.continuity",
      "dome.preference.promotion",
      "dome.meaning.integration",
      "dome.daily.edition",
    ]);

    for (const loop of FIRST_PARTY_MAINTENANCE_LOOPS) {
      expect(loop.goal.length).toBeGreaterThan(0);
      expect(loop.evidence.length).toBeGreaterThan(0);
      expect(loop.processors.length).toBeGreaterThan(0);
      expect(loop.surfaces.length).toBeGreaterThan(0);
      expect(loop.settlement.key.length).toBeGreaterThan(0);
      expect(loop.settlement.noOpWhen.length).toBeGreaterThan(0);
      expect(loop.settlement.checks.length).toBeGreaterThan(0);
      for (const check of loop.settlement.checks) {
        expect(check.name.length).toBeGreaterThan(0);
        expect(check.description.length).toBeGreaterThan(0);
      }
      expect(loop.risks.length).toBeGreaterThan(0);
    }
  });

  test("reference shipped processors and command surfaces", async () => {
    const bundles = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(bundles.ok).toBe(true);
    if (!bundles.ok) return;

    const processors = flattenBundleProcessors(bundles.value);
    const processorIds = new Set(processors.map((processor) => processor.id));
    const commandNames = new Set(
      processors.flatMap((processor) =>
        processor.triggers.flatMap((trigger) =>
          trigger.kind === "command" ? [publicViewCommandName(trigger.name)] : []
        )
      ),
    );

    expect(validateMaintenanceLoops({
      loops: FIRST_PARTY_MAINTENANCE_LOOPS,
      processorIds,
      commandNames,
    })).toEqual([]);
  });

  test("cover every shipped first-party maintenance processor", async () => {
    const bundles = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
    expect(bundles.ok).toBe(true);
    if (!bundles.ok) return;

    const shippedProcessorIds = flattenBundleProcessors(bundles.value)
      .map((processor) => processor.id)
      .sort();
    const loopProcessorIds = new Set(
      FIRST_PARTY_MAINTENANCE_LOOPS.flatMap((loop) => [
        ...loop.processors,
        ...(loop.optionalProcessors ?? []),
      ]),
    );
    const uncovered = shippedProcessorIds.filter(
      (processorId) =>
        !loopProcessorIds.has(processorId) &&
        !EXEMPT_FIRST_PARTY_PROCESSORS.has(processorId),
    );

    expect(uncovered).toEqual([]);
    expect(shippedProcessorIds).toEqual(
      expect.arrayContaining([...EXEMPT_FIRST_PARTY_PROCESSORS]),
    );
  });

  test("validation catches stale processor references", () => {
    const [loop] = FIRST_PARTY_MAINTENANCE_LOOPS;
    if (loop === undefined) throw new Error("expected first-party loop");

    const errors = validateMaintenanceLoops({
      loops: [
        {
          ...loop,
          processors: ["missing.processor"],
        },
      ],
      processorIds: new Set(),
      commandNames: new Set(),
    });

    expect(errors).toContainEqual({
      kind: "missing-processor",
      loopId: loop.id,
      processorId: "missing.processor",
    });
  });

  test("validation catches stale optional processor references", () => {
    const [loop] = FIRST_PARTY_MAINTENANCE_LOOPS;
    if (loop === undefined) throw new Error("expected first-party loop");

    const errors = validateMaintenanceLoops({
      loops: [
        {
          ...loop,
          optionalProcessors: ["missing.optional-processor"],
        },
      ],
      processorIds: new Set(loop.processors),
      commandNames: new Set(),
    });

    expect(errors).toContainEqual({
      kind: "missing-processor",
      loopId: loop.id,
      processorId: "missing.optional-processor",
    });
  });

  test("validation catches malformed loop metadata", () => {
    const [loop] = FIRST_PARTY_MAINTENANCE_LOOPS;
    if (loop === undefined) throw new Error("expected first-party loop");

    const errors = validateMaintenanceLoops({
      loops: [
        {
          ...loop,
          id: "bad loop id",
          goal: "",
          evidence: [],
          processors: [],
          surfaces: [],
          settlement: {
            key: "",
            noOpWhen: "",
            checks: [],
          },
          risks: [],
        },
      ],
      processorIds: new Set(),
      commandNames: new Set(),
    });

    expect(errors).toContainEqual({
      kind: "invalid-loop-id",
      loopId: "bad loop id",
    });
    expect(errors).toContainEqual({
      kind: "empty-field",
      loopId: "bad loop id",
      field: "goal",
    });
    expect(errors).toContainEqual({
      kind: "empty-field",
      loopId: "bad loop id",
      field: "evidence",
    });
    expect(errors).toContainEqual({
      kind: "empty-field",
      loopId: "bad loop id",
      field: "processors",
    });
    expect(errors).toContainEqual({
      kind: "empty-field",
      loopId: "bad loop id",
      field: "surfaces",
    });
    expect(errors).toContainEqual({
      kind: "empty-field",
      loopId: "bad loop id",
      field: "settlement.key",
    });
    expect(errors).toContainEqual({
      kind: "empty-field",
      loopId: "bad loop id",
      field: "settlement.noOpWhen",
    });
    expect(errors).toContainEqual({
      kind: "empty-field",
      loopId: "bad loop id",
      field: "settlement.checks",
    });
    expect(errors).toContainEqual({
      kind: "empty-field",
      loopId: "bad loop id",
      field: "risks",
    });
  });

  test("validation catches malformed settlement checks", () => {
    const [loop] = FIRST_PARTY_MAINTENANCE_LOOPS;
    if (loop === undefined) throw new Error("expected first-party loop");

    const errors = validateMaintenanceLoops({
      loops: [
        {
          ...loop,
          settlement: {
            ...loop.settlement,
            checks: [
              {
                kind: "unknown-settlement-check",
                name: "",
                description: "",
              },
              {
                kind: "no-open-questions",
                name: "duplicate",
                description: "No questions remain.",
              },
              {
                kind: "no-recent-problem-runs",
                name: "duplicate",
                description: "No problem runs remain.",
              },
            ] as unknown as typeof loop.settlement.checks,
          },
        },
      ],
      processorIds: new Set(loop.processors),
      commandNames: commandNamesFor(loop),
    });

    expect(errors).toContainEqual({
      kind: "invalid-settlement-check",
      loopId: loop.id,
      checkKind: "unknown-settlement-check",
    });
    expect(errors).toContainEqual({
      kind: "empty-field",
      loopId: loop.id,
      field: "settlement.check.name",
    });
    expect(errors).toContainEqual({
      kind: "empty-field",
      loopId: loop.id,
      field: "settlement.check.description",
    });
    expect(errors).toContainEqual({
      kind: "duplicate-settlement-check",
      loopId: loop.id,
      checkName: "duplicate",
    });
  });

  test("validation catches duplicate loop and processor references", () => {
    const [loop] = FIRST_PARTY_MAINTENANCE_LOOPS;
    if (loop === undefined) throw new Error("expected first-party loop");
    const [processor] = loop.processors;
    if (processor === undefined) throw new Error("expected processor");

    const errors = validateMaintenanceLoops({
      loops: [
        loop,
        {
          ...loop,
          processors: [processor, processor],
        },
      ],
      processorIds: new Set(loop.processors),
      commandNames: commandNamesFor(loop),
    });

    expect(errors).toContainEqual({
      kind: "duplicate-loop-id",
      loopId: loop.id,
    });
    expect(errors).toContainEqual({
      kind: "duplicate-processor",
      loopId: loop.id,
      processorId: processor,
    });
  });

  test("validation catches invalid surfaces and evidence", () => {
    const [loop] = FIRST_PARTY_MAINTENANCE_LOOPS;
    if (loop === undefined) throw new Error("expected first-party loop");

    const errors = validateMaintenanceLoops({
      loops: [
        {
          ...loop,
          evidence: [
            { kind: "path", pattern: "../outside.md" },
            { kind: "projection", name: "unknown_table" },
          ],
          surfaces: [
            { kind: "path", pattern: "/absolute.md" },
            { kind: "command", name: "missing-command" },
            { kind: "projection", name: "bad projection" },
            {
              kind: "status",
              name: "doctor",
            } as unknown as typeof loop.surfaces[number],
          ],
        },
      ],
      processorIds: new Set(loop.processors),
      commandNames: new Set(),
    });

    expect(errors).toContainEqual({
      kind: "invalid-path-pattern",
      loopId: loop.id,
      pattern: "../outside.md",
    });
    expect(errors).toContainEqual({
      kind: "invalid-path-pattern",
      loopId: loop.id,
      pattern: "/absolute.md",
    });
    expect(errors).toContainEqual({
      kind: "missing-command-surface",
      loopId: loop.id,
      commandName: "missing-command",
    });
    expect(errors).toContainEqual({
      kind: "invalid-projection",
      loopId: loop.id,
      projectionName: "unknown_table",
    });
    expect(errors).toContainEqual({
      kind: "invalid-projection",
      loopId: loop.id,
      projectionName: "bad projection",
    });
    expect(errors).toContainEqual({
      kind: "invalid-status-surface",
      loopId: loop.id,
      statusName: "doctor",
    });
  });

  test("command surfaces use public CLI names instead of internal view triggers", () => {
    const publicCommands = new Set(
      [...DEDICATED_VIEW_COMMAND_ALIASES.keys()].map(publicViewCommandName),
    );
    const commandSurfaces = FIRST_PARTY_MAINTENANCE_LOOPS.flatMap((loop) =>
      loop.surfaces.flatMap((surface) =>
        surface.kind === "command" ? [surface.name] : []
      )
    );

    expect(commandSurfaces).not.toContain("agenda-with");
    for (const command of commandSurfaces) {
      expect(publicCommands.has(command)).toBe(true);
    }
  });
});

function commandNamesFor(
  loop: (typeof FIRST_PARTY_MAINTENANCE_LOOPS)[number],
): ReadonlySet<string> {
  return new Set(
    loop.surfaces.flatMap((surface) =>
      surface.kind === "command" ? [surface.name] : []
    ),
  );
}
