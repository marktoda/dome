// dispatchGardenRun — the shared dispatch+route mechanism for one garden run
// (a non-signal garden-phase processor invocation: schedule fire, queued job,
// or answer handler). See src/engine/garden/garden-run.ts.
//
// These tests pin the module's interface: it builds the adopted snapshot,
// dispatches the processor, routes its effects through routeGardenRunEffects,
// and returns { result, routing }. The diagnostics accumulator is the caller's
// run-level array. The per-run `disabledDiagnostic` is forwarded so an
// authorized garden patch with no adoptSubProposal wired surfaces the run's
// own message.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defineProcessor,
  treeOid,
  type Capability,
} from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import {
  diagnosticEffect,
  patchEffect,
  type DiagnosticEffect,
} from "../../src/core/effect";
import { noopSinks, type ApplyEffectSinks } from "../../src/engine/core/apply-effect";
import type { EngineVault } from "../../src/engine/core/vault-shape";
import {
  dispatchGardenRun,
  type GardenRun,
  type GardenRunDeps,
} from "../../src/engine/garden/garden-run";

const ADOPTED = commitOid("adopted0000000000000000000000000000000000");
const TREE = treeOid("tree000000000000000000000000000000000000");
const NOW = new Date("2026-06-26T12:00:00.000Z");

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function makeVault(): EngineVault {
  const root = mkdtempSync(join(tmpdir(), "dome-garden-run-"));
  roots.push(root);
  return { path: root, config: { git: { auto_commit_workflows: false } } };
}

function baseDeps(
  vault: EngineVault,
  overrides: Partial<GardenRunDeps> = {},
): GardenRunDeps {
  return {
    vault,
    adopted: ADOPTED,
    resolveTree: async () => TREE,
    sinks: noopSinks(),
    resolveGrants: () => [],
    extensionIdFor: () => "test",
    applyGardenPatchToCandidate: async () => null,
    ...overrides,
  };
}

describe("dispatchGardenRun", () => {
  test("dispatches the processor against the adopted snapshot, routes its effects, and returns result+routing", async () => {
    const vault = makeVault();
    const finding = diagnosticEffect({
      severity: "warning",
      code: "test.finding",
      message: "still true",
      sourceRefs: [],
    });
    const processor = defineProcessor({
      id: "test.garden-run",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [],
      run: async () => [finding],
    });

    const seenDiagnostics: string[] = [];
    const sinks: ApplyEffectSinks = {
      ...noopSinks(),
      resolveDiagnostics: async (input) => {
        for (const d of input.emittedDiagnostics) seenDiagnostics.push(d.code);
      },
    };

    const diagnostics: DiagnosticEffect[] = [];
    const run: GardenRun = {
      processor,
      phase: "garden",
      envelope: Object.freeze({ kind: "schedule", cron: "* * * * *", firedAt: NOW.toISOString() }),
      matches: [
        { trigger: { kind: "schedule", cron: "* * * * *" }, matchedSignals: [] },
      ],
      now: NOW,
      disabledDiagnostic: {
        code: "test.run.spawn-disabled",
        message: "patch dropped in this test",
      },
    };

    const outcome = await dispatchGardenRun(baseDeps(vault, { sinks }), run, diagnostics);

    expect(outcome.result.processorId).toBe("test.garden-run");
    expect(outcome.result.executionStatus).toBe("succeeded");
    expect(outcome.routing.authorizedPatchCount).toBe(0);
    expect(outcome.routing.spawnedPatchCount).toBe(0);
    // The succeeded run's emitted diagnostic flows into resolveDiagnostics.
    expect(seenDiagnostics).toContain("test.finding");
  });

  test("forwards the per-run disabledDiagnostic when an authorized garden patch has no adoptSubProposal wired", async () => {
    const vault = makeVault();
    const patchGrant: Capability = { kind: "patch.auto", paths: ["wiki/**"] };
    const processor = defineProcessor({
      id: "test.garden-run.patcher",
      version: "0.0.1",
      phase: "garden",
      triggers: [{ kind: "schedule", cron: "* * * * *" }],
      capabilities: [patchGrant],
      run: async () => [
        patchEffect({
          mode: "auto",
          changes: [{ kind: "write", path: "wiki/x.md", content: "hi" }],
          reason: "test patch",
          sourceRefs: [],
        }),
      ],
    });

    const diagnostics: DiagnosticEffect[] = [];
    const run: GardenRun = {
      processor,
      phase: "garden",
      envelope: Object.freeze({ kind: "schedule", cron: "* * * * *", firedAt: NOW.toISOString() }),
      matches: [
        { trigger: { kind: "schedule", cron: "* * * * *" }, matchedSignals: [] },
      ],
      disabledDiagnostic: {
        code: "test.run.spawn-disabled",
        message: "patch dropped in this test",
      },
    };

    // adoptSubProposal intentionally NOT wired → the authorized patch cannot
    // spawn, so the run's disabledDiagnostic must surface.
    await dispatchGardenRun(
      baseDeps(vault, { resolveGrants: () => [patchGrant] }),
      run,
      diagnostics,
    );

    expect(diagnostics.map((d) => d.code)).toContain("test.run.spawn-disabled");
  });
});
