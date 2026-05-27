// Smoke tests for src/engine/adopt.ts: the fixed-point adoption loop with a
// stub `AdoptionPhaseRunner`. Uses a minimal real git repo (one commit) so
// `currentBranch` / `currentSha` / `setAdoptedRef` work; bypasses
// `makeTestVault` since the bootstrap chain is heavy and Phase 3 will wire
// the AdoptionPhaseRunner against the processor registry anyway.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adopt } from "../../src/engine/adopt";
import type { AdoptionPhaseRunner } from "../../src/engine/runner-contract";
import { noopSinks } from "../../src/engine/apply-effect";
import { diagnosticEffect, patchEffect } from "../../src/core/effect";
import { commitOid } from "../../src/core/source-ref";
import { manualProposal } from "../../src/core/proposal";
import { commit, initRepo, currentSha } from "../../src/git";
import type { Vault } from "../../src/vault";

type Fixture = {
  vault: Vault;
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
  const vault = {
    path,
    config: {
      invariants: {},
      hooks: { builtin: {}, max_causation_depth: 0, inbox_stale_age_hours: 0 },
      git: { auto_commit_workflows: autoCommit },
    },
  } as unknown as Vault;
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
    const proposal = manualProposal({
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
    const proposal = manualProposal({
      id: "prop_1_aaaaaa",
      base: commitOid(sha),
      head: commitOid(sha),
      branch: "main",
    });
    const runner: AdoptionPhaseRunner = async () => [
      {
        processorId: "test.blocker",
        declared: [],
        granted: [],
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
    const proposal = manualProposal({
      id: "prop_1_aaaaaa",
      base: commitOid(sha),
      head: commitOid(sha),
      branch: "main",
    });
    // Declared+granted patch.auto so the broker allows the patch through and
    // the loop counts it as an auto patch (without these, the broker would
    // deny and the loop would converge on iter 1).
    const auto = { kind: "patch.auto" as const, paths: ["wiki/**"] };
    const runner: AdoptionPhaseRunner = async () => [
      {
        processorId: "test.diverger",
        declared: [auto],
        granted: [auto],
        effects: [
          patchEffect({
            mode: "auto",
            patch: "--- a/wiki/seed.md\n+++ b/wiki/seed.md\n",
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
      sinks: noopSinks(),
      maxIterations: 3,
    });

    expect(r.adopted).toBe(false);
    expect(r.iterations).toBe(3);
    expect(r.diagnostics.some((d) => d.code === "fixed-point.divergence")).toBe(
      true,
    );
  });
});
