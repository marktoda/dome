// Smoke tests for src/engine/core/adopt.ts: the fixed-point adoption loop with a
// stub `AdoptionPhaseRunner`. Uses a minimal real git repo (one commit) so
// `currentBranch` / `currentSha` / `setAdoptedRef` work; bypasses
// `makeTestVault` since the bootstrap chain is heavy and Phase 3 will wire
// the AdoptionPhaseRunner against the processor registry anyway.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adopt } from "../../src/engine/core/adopt";
import { applyPatchToCandidate } from "../../src/engine/core/apply-patch";
import type {
  AdoptionPhaseRunner,
  RunId,
} from "../../src/engine/core/runner-contract";
import { noopSinks } from "../../src/engine/core/apply-effect";
import { diagnosticEffect, patchEffect } from "../../src/core/effect";
import { commitOid } from "../../src/core/source-ref";
import { makeManualProposal } from "../../src/core/proposal";
import type { EngineVault } from "../../src/engine/core/vault-shape";
import {
  checkoutPathsAtRef,
  commit,
  initRepo,
  currentSha,
  readRef,
  writeRef,
} from "../../src/git";

type Fixture = {
  vault: EngineVault;
  baseSha: string;
  cleanup: () => Promise<void>;
};

async function makeMinimalGitVault(autoCommit = true): Promise<Fixture> {
  const path = mkdtempSync(join(tmpdir(), "adopt-"));
  await initRepo(path);
  await mkdir(join(path, "wiki"), { recursive: true });
  await writeFile(join(path, "wiki/seed.md"), "seed\n");
  const baseSha = await commit({
    path,
    message: "init\n",
    files: ["wiki/seed.md"],
  });
  const vault: EngineVault = {
    path,
    config: {
      git: { auto_commit_workflows: autoCommit },
    },
  };
  return {
    vault,
    baseSha,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

describe("adopt fixed-point loop", () => {
  test("happy path — stub runner returns no effects → converges on iter 1, adopted=true", async () => {
    const f = await makeMinimalGitVault();
    fixtures.push(f);
    const sha = await currentSha(f.vault.path);
    if (sha === null) throw new Error("expected sha");
    const proposal = makeManualProposal({
      id: "prop_1_aaaaaa",
      base: commitOid(sha),
      head: commitOid(sha),
      branch: "main",
    });
    const runner: AdoptionPhaseRunner = async () => [];

    const r = await adopt({
      vault: f.vault,
      proposal,
      runAdoptionProcessors: runner,
      sinks: noopSinks(),
    });

    expect(r.adopted).toBe(true);
    expect(r.iterations).toBe(1);
  });

  test("block-severity diagnostic — runner emits one block diag → adopted=false, diag in result", async () => {
    const f = await makeMinimalGitVault();
    fixtures.push(f);
    const sha = await currentSha(f.vault.path);
    if (sha === null) throw new Error("expected sha");
    const proposal = makeManualProposal({
      id: "prop_1_aaaaaa",
      base: commitOid(sha),
      head: commitOid(sha),
      branch: "main",
    });
    const runner: AdoptionPhaseRunner = async () => [
      {
        runId: "run_test_blocker" as RunId,
        processorId: "test.blocker",
        executionStatus: "succeeded",
        declared: [],
        granted: [],
        inspectedPaths: [],
        effects: [
          diagnosticEffect({
            severity: "block",
            code: "test.block",
            message: "blocked",
            sourceRefs: [],
          }),
        ],
      },
    ];

    const r = await adopt({
      vault: f.vault,
      proposal,
      runAdoptionProcessors: runner,
      sinks: noopSinks(),
    });

    expect(r.adopted).toBe(false);
    expect(r.iterations).toBe(1);
    expect(r.diagnostics.some((d) => d.code === "test.block")).toBe(true);
  });

  test("divergence — runner always emits an auto patch → MAX_ITER cap → fixed-point.divergence", async () => {
    const f = await makeMinimalGitVault();
    fixtures.push(f);
    const sha = await currentSha(f.vault.path);
    if (sha === null) throw new Error("expected sha");
    const proposal = makeManualProposal({
      id: "prop_1_aaaaaa",
      base: commitOid(sha),
      head: commitOid(sha),
      branch: "main",
    });
    // Declared+granted patch.auto so the broker allows the patch through and
    // the loop counts it as an auto patch (without these, the broker would
    // deny and the loop would converge on iter 1).
    const auto = { kind: "patch.auto" as const, paths: ["wiki/**"] };
    const recorded: Array<{
      readonly code: string;
      readonly processorId: string;
      readonly proposalId: string | null;
    }> = [];
    const runner: AdoptionPhaseRunner = async () => [
      {
        runId: "run_test_diverger" as RunId,
        processorId: "test.diverger",
        executionStatus: "succeeded",
        declared: [auto],
        granted: [auto],
        inspectedPaths: [],
        effects: [
          patchEffect({
            mode: "auto",
            changes: [
              { kind: "write", path: "wiki/seed.md", content: "diverge\n" },
            ],
            reason: "diverge",
            sourceRefs: [],
          }),
        ],
      },
    ];

    const r = await adopt({
      vault: f.vault,
      proposal,
      runAdoptionProcessors: runner,
      sinks: {
        ...noopSinks(),
        recordDiagnostic: async ({ effect, processorId, proposalId }) => {
          recorded.push({ code: effect.code, processorId, proposalId });
        },
      },
      maxIterations: 3,
    });

    expect(r.adopted).toBe(false);
    expect(r.iterations).toBe(3);
    const divergence = r.diagnostics.find(
      (d) => d.code === "fixed-point.divergence",
    );
    expect(divergence).toBeDefined();
    expect(divergence?.message).toContain("MAX_ITER=3");
    expect(divergence?.message).toContain("test.diverger");
    expect(divergence?.message).toContain("patch:auto[write:wiki/seed.md]");
    expect(divergence?.message).toContain("Candidate processors: test.diverger");
    expect(recorded).toEqual([
      {
        code: "fixed-point.divergence",
        processorId: "engine.adoption",
        proposalId: "prop_1_aaaaaa",
      },
    ]);
  });

  test("projection cleanup uses runner inspectedPaths, not full changedPaths", async () => {
    const f = await makeMinimalGitVault();
    fixtures.push(f);
    await writeFile(join(f.vault.path, "wiki", "visible.md"), "visible\n");
    await mkdir(join(f.vault.path, "secret"), { recursive: true });
    await writeFile(join(f.vault.path, "secret", "hidden.md"), "hidden\n");
    const head = await commit({
      path: f.vault.path,
      message: "mixed visible and hidden changes\n",
      files: ["wiki/visible.md", "secret/hidden.md"],
    });
    const proposal = makeManualProposal({
      id: "prop_inspected_paths",
      base: commitOid(f.baseSha),
      head: commitOid(head),
      branch: "main",
    });
    const inspectedPaths = Object.freeze(["wiki/visible.md"]);
    const runner: AdoptionPhaseRunner = async (input) => {
      expect([...input.changedPaths].sort()).toEqual([
        "secret/hidden.md",
        "wiki/visible.md",
      ]);
      return [
        {
          runId: "run_test_inspected" as RunId,
          processorId: "test.inspected",
          executionStatus: "succeeded",
          declared: [],
          granted: [],
          inspectedPaths,
          effects: [],
        },
      ];
    };
    const resolvedFacts: ReadonlyArray<string>[] = [];
    const resolvedDiagnostics: Array<{
      readonly processorId: string;
      readonly inspectedPaths: ReadonlyArray<string>;
    }> = [];

    const r = await adopt({
      vault: f.vault,
      proposal,
      runAdoptionProcessors: runner,
      sinks: {
        ...noopSinks(),
        resolveFacts: async (input) => {
          resolvedFacts.push(input.inspectedPaths);
        },
        resolveDiagnostics: async (input) => {
          resolvedDiagnostics.push({
            processorId: input.processorId,
            inspectedPaths: input.inspectedPaths,
          });
        },
      },
    });

    expect(r.adopted).toBe(true);
    expect(resolvedFacts).toEqual([["wiki/visible.md"]]);
    expect(resolvedDiagnostics).toEqual([
      { processorId: "engine.adoption", inspectedPaths: [] },
      { processorId: "test.inspected", inspectedPaths: ["wiki/visible.md"] },
    ]);
  });

  test("adopted-ref refusal rolls branch and working tree back to source head", async () => {
    const f = await makeMinimalGitVault();
    fixtures.push(f);

    await writeFile(join(f.vault.path, "wiki", "seed.md"), "user\n");
    const userHead = await commit({
      path: f.vault.path,
      message: "user edit\n",
      files: ["wiki/seed.md"],
    });

    await writeRef({
      path: f.vault.path,
      ref: "refs/heads/main",
      value: f.baseSha,
    });
    await writeFile(join(f.vault.path, "wiki", "seed.md"), "stale adopted\n");
    const staleAdopted = await commit({
      path: f.vault.path,
      message: "stale adopted sibling\n",
      files: ["wiki/seed.md"],
    });
    await writeRef({
      path: f.vault.path,
      ref: "refs/dome/adopted/main",
      value: staleAdopted,
    });
    // Park the branch back on the proposal head with matching working-tree
    // content, so the finalization fast-forward guard passes and the
    // refusal under test comes from `setAdoptedRef` (stale adopted cursor),
    // exercising the rollback path.
    await writeRef({
      path: f.vault.path,
      ref: "refs/heads/main",
      value: userHead,
    });
    await checkoutPathsAtRef({
      path: f.vault.path,
      ref: userHead,
      filepaths: ["wiki/seed.md"],
      force: true,
    });

    const proposal = makeManualProposal({
      id: "prop_stale_adopted",
      base: commitOid(f.baseSha),
      head: commitOid(userHead),
      branch: "main",
    });
    const auto = { kind: "patch.auto" as const, paths: ["wiki/**"] };
    let ran = false;
    const runner: AdoptionPhaseRunner = async () => {
      if (ran) return [];
      ran = true;
      return [
        {
          runId: "run_test_ref_refusal" as RunId,
          processorId: "test.patch",
          executionStatus: "succeeded",
          declared: [auto],
          granted: [auto],
          inspectedPaths: ["wiki/seed.md"],
          effects: [
            patchEffect({
              mode: "auto",
              changes: [
                { kind: "write", path: "wiki/seed.md", content: "engine\n" },
              ],
              reason: "engine normalization",
              sourceRefs: [],
            }),
          ],
        },
      ];
    };

    const r = await adopt({
      vault: f.vault,
      proposal,
      runAdoptionProcessors: runner,
      sinks: {
        ...noopSinks(),
        applyPatch: async ({ effect, processorId, runId, candidate }) =>
          applyPatchToCandidate({
            vaultPath: f.vault.path,
            candidate,
            patch: effect,
            runContext: {
              runId,
              processorId,
              extensionId: "test",
              base: proposal.base,
              sourceHead: commitOid(staleAdopted),
            },
          }),
      },
    });

    expect(r.adopted).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "adoption.ref-advance-refused"))
      .toBe(true);
    expect(await readRef({ path: f.vault.path, ref: "refs/heads/main" }))
      .toBe(userHead);
    expect(await readRef({ path: f.vault.path, ref: "refs/dome/adopted/main" }))
      .toBe(staleAdopted);
    const workingTree = await Bun.file(
      join(f.vault.path, "wiki", "seed.md"),
    ).text();
    expect(workingTree).toBe("user\n");
  });

  test("concurrent user commit during proposal adoption refuses the branch advance instead of rewinding past it", async () => {
    // Reconstructs the garden sub-Proposal race: the proposal head is a
    // floating engine commit whose parent is the adopted commit, while a
    // user commit landed on the branch after the proposal was constructed.
    // The branch head observed at loop start is NOT an ancestor of the
    // candidate, so advancing would orphan the user's commit and revert
    // their content during materialization.
    const f = await makeMinimalGitVault();
    fixtures.push(f);

    await writeRef({
      path: f.vault.path,
      ref: "refs/dome/adopted/main",
      value: f.baseSha,
    });

    // Floating engine commit E (parent = adopted base).
    await writeFile(join(f.vault.path, "wiki", "seed.md"), "engine\n");
    const engineSha = await commit({
      path: f.vault.path,
      message: "garden engine work\n",
      files: ["wiki/seed.md"],
    });
    await writeRef({
      path: f.vault.path,
      ref: "refs/heads/main",
      value: f.baseSha,
    });

    // Concurrent user commit U (parent = adopted base) — the live branch head.
    await writeFile(join(f.vault.path, "wiki", "seed.md"), "user concurrent\n");
    const userSha = await commit({
      path: f.vault.path,
      message: "user concurrent edit\n",
      files: ["wiki/seed.md"],
    });

    const proposal = makeManualProposal({
      id: "prop_concurrent_commit",
      base: commitOid(f.baseSha),
      head: commitOid(engineSha),
      branch: "main",
    });
    const runner: AdoptionPhaseRunner = async () => [];

    const r = await adopt({
      vault: f.vault,
      proposal,
      runAdoptionProcessors: runner,
      sinks: noopSinks(),
    });

    expect(r.adopted).toBe(false);
    expect(
      r.diagnostics.some(
        (d) => d.code === "adoption.branch-advance-not-fast-forward",
      ),
    ).toBe(true);
    // No refs moved: the user's commit is still the branch head, the adopted
    // cursor is untouched, and the user's working-tree content survives.
    expect(await readRef({ path: f.vault.path, ref: "refs/heads/main" }))
      .toBe(userSha);
    expect(await readRef({ path: f.vault.path, ref: "refs/dome/adopted/main" }))
      .toBe(f.baseSha);
    const workingTree = await Bun.file(
      join(f.vault.path, "wiki", "seed.md"),
    ).text();
    expect(workingTree).toBe("user concurrent\n");
  });
});
