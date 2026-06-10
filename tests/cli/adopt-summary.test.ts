import { describe, expect, test } from "bun:test";

import {
  activeGardenProcessorIds,
  formatAdoptedSummaryLine,
} from "../../src/cli/commands/sync-shared";
import { diagnosticEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import type { GardenPhaseResult } from "../../src/engine/garden/garden";
import type { RunId } from "../../src/ledger/runs";

const UNICODE_CAPS = Object.freeze({ color: false, unicode: true, width: 120 });
const ASCII_CAPS = Object.freeze({ color: false, unicode: false, width: 120 });

const REF = sourceRef({
  commit: commitOid("abc123"),
  path: "wiki/test.md",
  range: { startLine: 1, endLine: 1 },
});

function diag(severity: "info" | "warning" | "error" | "block", code: string) {
  return diagnosticEffect({ severity, code, message: code, sourceRefs: [REF] });
}

describe("formatAdoptedSummaryLine", () => {
  test("renders branch, short sha, iteration and zero-diagnostic counts", () => {
    const line = formatAdoptedSummaryLine(
      {
        command: "serve",
        branch: "main",
        adoptedRef: "84b81a3ffffffff",
        iterations: 1,
        diagnostics: [],
        activeProcessorIds: [],
      },
      UNICODE_CAPS,
    );
    expect(line).toBe("dome serve: adopted main 84b81a3 · 1 iteration · 0 diagnostics");
  });

  test("pluralizes iterations and diagnostics and appends severity breakdown", () => {
    const line = formatAdoptedSummaryLine(
      {
        command: "serve",
        branch: "main",
        adoptedRef: "84b81a3000",
        iterations: 2,
        diagnostics: [
          diag("info", "a"),
          diag("info", "b"),
          diag("warning", "c"),
        ],
        activeProcessorIds: [],
      },
      UNICODE_CAPS,
    );
    expect(line).toBe(
      "dome serve: adopted main 84b81a3 · 2 iterations · 3 diagnostics (1 warning, 2 info)",
    );
  });

  test("orders severity breakdown most-severe-first and omits zero buckets", () => {
    const line = formatAdoptedSummaryLine(
      {
        command: "serve",
        branch: "main",
        adoptedRef: "deadbeef",
        iterations: 1,
        diagnostics: [diag("error", "e"), diag("warning", "w"), diag("info", "i")],
        activeProcessorIds: [],
      },
      UNICODE_CAPS,
    );
    expect(line).toContain("3 diagnostics (1 error, 1 warning, 1 info)");
  });

  test("lists active processors sorted, capped with +N more", () => {
    const line = formatAdoptedSummaryLine(
      {
        command: "serve",
        branch: "main",
        adoptedRef: "84b81a3",
        iterations: 1,
        diagnostics: [],
        activeProcessorIds: [
          "dome.search",
          "dome.markdown",
          "dome.graph",
          "dome.health",
          "dome.daily",
          "dome.agent",
        ],
      },
      UNICODE_CAPS,
      { maxProcessors: 4 },
    );
    expect(line).toBe(
      "dome serve: adopted main 84b81a3 · 1 iteration · 0 diagnostics · " +
        "ran dome.agent, dome.daily, dome.graph, dome.health +2 more",
    );
  });

  test("lists all processors when under the cap without +N more", () => {
    const line = formatAdoptedSummaryLine(
      {
        command: "serve",
        branch: "main",
        adoptedRef: "84b81a3",
        iterations: 1,
        diagnostics: [],
        activeProcessorIds: ["dome.graph", "dome.markdown"],
      },
      UNICODE_CAPS,
    );
    expect(line).toContain("· ran dome.graph, dome.markdown");
    expect(line).not.toContain("more");
  });

  test("uses ascii separator under ascii caps", () => {
    const line = formatAdoptedSummaryLine(
      {
        command: "serve",
        branch: "main",
        adoptedRef: "84b81a3",
        iterations: 1,
        diagnostics: [],
        activeProcessorIds: [],
      },
      ASCII_CAPS,
    );
    expect(line).toBe("dome serve: adopted main 84b81a3 - 1 iteration - 0 diagnostics");
  });

  test("uses the sync command prefix", () => {
    const line = formatAdoptedSummaryLine(
      {
        command: "sync",
        branch: "work",
        adoptedRef: "84b81a3",
        iterations: 1,
        diagnostics: [],
        activeProcessorIds: [],
      },
      UNICODE_CAPS,
    );
    expect(line).toStartWith("dome sync: adopted work 84b81a3");
  });
});

describe("activeGardenProcessorIds", () => {
  function gardenWith(
    runs: ReadonlyArray<{ processorId: string; effectCount: number }>,
  ): GardenPhaseResult {
    return {
      proposalId: "prop_1",
      runs: runs.map((r) => ({
        runId: "run-x" as unknown as RunId,
        processorId: r.processorId,
        effectCount: r.effectCount,
        authorizedPatchCount: 0,
      })),
      subProposalCount: 0,
      rejectedPatchCount: 0,
      diagnostics: [],
      cascadeDepth: 0,
    };
  }

  test("returns sorted processor ids that emitted at least one effect", () => {
    const ids = activeGardenProcessorIds(
      gardenWith([
        { processorId: "dome.search", effectCount: 2 },
        { processorId: "dome.graph", effectCount: 1 },
      ]),
    );
    expect(ids).toEqual(["dome.graph", "dome.search"]);
  });

  test("excludes processors that ran but emitted nothing", () => {
    const ids = activeGardenProcessorIds(
      gardenWith([
        { processorId: "dome.graph", effectCount: 0 },
        { processorId: "dome.search", effectCount: 3 },
      ]),
    );
    expect(ids).toEqual(["dome.search"]);
  });

  test("dedupes a processor that ran across multiple summaries", () => {
    const ids = activeGardenProcessorIds(
      gardenWith([
        { processorId: "dome.graph", effectCount: 1 },
        { processorId: "dome.graph", effectCount: 2 },
      ]),
    );
    expect(ids).toEqual(["dome.graph"]);
  });
});
