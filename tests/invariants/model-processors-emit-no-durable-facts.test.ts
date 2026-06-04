// Structural enforcement for invariant MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS.
//
// The substrate spec at
// docs/wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS.md describes the
// rule: a garden-phase processor granted `model.invoke` must NOT declare
// `graph.write`. Model-derived judgment is transient — it surfaces as a
// QuestionEffect (made durable by the human/agent resolution in answers.db,
// which rehydrates on rebuild) or as a regenerated generated-surface
// PatchEffect — never as a FactEffect that would silently vanish on
// `dome rebuild`.
//
// This is enforced by construction: projection rebuild's
// REBUILD_SAFE_GARDEN_CAPABILITIES set ({read, graph.write, search.write,
// question.ask}) excludes `model.invoke`, so a garden processor holding
// `model.invoke` is NOT re-run during rebuild. Any FactEffect it emitted would
// not be reconstructable, breaking PROJECTIONS_ARE_REBUILDABLE. The manifest
// rule below makes that impossible: no garden `model.invoke` processor declares
// `graph.write`.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveShippedBundlesRoot } from "../../src/cli/commands/sync-shared";
import { flattenBundleProcessors, loadBundles } from "../../src/extensions/loader";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INVARIANT_DOC = join(
  REPO_ROOT,
  "docs",
  "wiki",
  "invariants",
  "MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS.md",
);

describe("MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS", () => {
  test("invariant doc exists at the canonical path", () => {
    expect(existsSync(INVARIANT_DOC)).toBe(true);
  });

  test("no garden model.invoke processor declares graph.write", async () => {
    const loaded = await loadBundles({
      bundlesRoot: resolveShippedBundlesRoot(),
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.kind);

    const processors = flattenBundleProcessors(loaded.value);

    const violations: string[] = [];
    for (const processor of processors) {
      if (processor.phase !== "garden") continue;
      const kinds = new Set(
        processor.capabilities.map((capability) => capability.kind),
      );
      if (kinds.has("model.invoke") && kinds.has("graph.write")) {
        violations.push(processor.id);
      }
    }

    expect(violations).toEqual([]);
  });
});
