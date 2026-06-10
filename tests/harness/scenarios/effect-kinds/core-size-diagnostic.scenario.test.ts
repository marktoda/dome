// scenarios/effect-kinds/core-size-diagnostic.scenario.test.ts
//
// dome.markdown.core-size warns when the vault-root core.md exceeds the
// ~6,000-character core-memory budget (docs/memory.md §M3). This scenario
// runs through the REAL shipped grant path: the vault config is the literal
// `defaultConfigYaml()` that `dome init` renders, so it pins that the
// default dome.markdown read grant actually covers core.md — a vault config
// lacking that entry silently kills the lint (effective read = ∅).

import { expect } from "bun:test";

import { defaultConfigYaml } from "../../../../src/cli/default-vault-config";
import { CORE_SIZE_BUDGET_CHARS } from "../../../../assets/extensions/dome.markdown/processors/core-size";
import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: core-size lint fires through the shipped default grant",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "trigger", trigger: "signal" },
      { kind: "capability", capability: "read" },
    ],
    harness: {
      // The enabled set from FIRST_PARTY_EXTENSION_DEFAULTS — the config
      // below is the exact YAML `dome init` writes.
      bundles: [
        "dome.lint",
        "dome.markdown",
        "dome.graph",
        "dome.daily",
        "dome.claims",
        "dome.search",
        "dome.sources",
        "dome.health",
      ],
      initialFiles: {
        ".dome/config.yaml": defaultConfigYaml(),
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    // An in-budget core.md raises nothing.
    await h.userCommit({
      files: {
        "core.md": "# Core memory\n\n## Standing preferences\n",
      },
      message: "seed core memory",
    });
    const inBudget = await h.tick();
    expect(inBudget.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.core-oversize" })
      .toHaveCount(0);

    // Push core.md past the budget — the warning must fire through the
    // shipped default grant (no test-only grant widening).
    const filler = `- ${"core memory line item. ".repeat(12)}\n`;
    let oversized = "# Core memory\n\n## Standing preferences\n\n";
    while (oversized.length <= CORE_SIZE_BUDGET_CHARS) oversized += filler;
    await h.userCommit({
      files: { "core.md": oversized },
      message: "overstuff core memory",
    });
    const oversize = await h.tick();
    expect(oversize.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.core-oversize" })
      .toHaveCount(1);
    await h
      .expectLedger({ processorId: "dome.markdown.core-size" })
      .toAllHaveStatus("succeeded");
  },
);
