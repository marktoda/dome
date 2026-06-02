import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIRST_PARTY_MAINTENANCE_LOOPS,
  validateMaintenanceLoops,
} from "../../src/extensions/maintenance-loops";
import {
  flattenBundleProcessors,
  loadBundles,
} from "../../src/extensions/loader";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");

describe("first-party maintenance loops", () => {
  test("declare the five V1 loop design units", () => {
    expect(FIRST_PARTY_MAINTENANCE_LOOPS.map((loop) => loop.id)).toEqual([
      "dome.capture.digest",
      "dome.open-loop.continuity",
      "dome.link-concept.coherence",
      "dome.context.packet",
      "dome.question.continuity",
    ]);

    for (const loop of FIRST_PARTY_MAINTENANCE_LOOPS) {
      expect(loop.goal.length).toBeGreaterThan(0);
      expect(loop.evidence.length).toBeGreaterThan(0);
      expect(loop.processors.length).toBeGreaterThan(0);
      expect(loop.surfaces.length).toBeGreaterThan(0);
      expect(loop.settlement.key.length).toBeGreaterThan(0);
      expect(loop.settlement.noOpWhen.length).toBeGreaterThan(0);
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
          trigger.kind === "command" ? [trigger.name] : []
        )
      ),
    );

    expect(validateMaintenanceLoops({
      loops: FIRST_PARTY_MAINTENANCE_LOOPS,
      processorIds,
      commandNames,
    })).toEqual([]);
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
});
