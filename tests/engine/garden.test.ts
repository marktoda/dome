import { describe, expect, test } from "bun:test";

import { diagnosticEffect } from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { noopSinks } from "../../src/engine/apply-effect";
import { runGardenPhase } from "../../src/engine/garden";
import type { RunId } from "../../src/engine/runner-contract";

describe("runGardenPhase", () => {
  test("successful garden runs resolve stale diagnostics for inspected paths", async () => {
    const adopted = commitOid("abc123");
    const proposal = makeManualProposal({
      id: "prop_1_garden",
      base: adopted,
      head: adopted,
      branch: "main",
    });
    const effect = diagnosticEffect({
      severity: "warning",
      code: "test.warn",
      message: "warn",
      sourceRefs: [sourceRef({ commit: adopted, path: "wiki/a.md" })],
    });

    const recorded: string[] = [];
    const resolved: Array<{
      readonly processorId: string;
      readonly inspectedPaths: ReadonlyArray<string>;
      readonly emittedCodes: ReadonlyArray<string>;
    }> = [];

    const result = await runGardenPhase({
      vault: {
        path: "/tmp/vault",
        config: { git: { auto_commit_workflows: true } },
      },
      proposal,
      adopted,
      changedPaths: ["wiki/a.md"],
      signals: [{ signal: "document.changed", path: "wiki/a.md" }],
      runGardenProcessors: async () => [
        {
          runId: "run_garden_diag" as RunId,
          processorId: "test.garden.diag",
          executionStatus: "succeeded",
          declared: [{ kind: "read", paths: ["wiki/**"] }],
          granted: [{ kind: "read", paths: ["wiki/**"] }],
          inspectedPaths: ["wiki/a.md"],
          effects: [effect],
        },
      ],
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect }) => {
          recorded.push(effect.code);
        },
        resolveDiagnostics: async (input) => {
          resolved.push({
            processorId: input.processorId,
            inspectedPaths: input.inspectedPaths,
            emittedCodes: input.emittedDiagnostics.map((d) => d.code),
          });
        },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(recorded).toEqual(["test.warn"]);
    expect(resolved).toEqual([
      {
        processorId: "test.garden.diag",
        inspectedPaths: ["wiki/a.md"],
        emittedCodes: ["test.warn"],
      },
    ]);
  });
});
