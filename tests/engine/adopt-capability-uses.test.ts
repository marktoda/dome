// Phase 6 — engine adoption-loop capability-use recording.
//
// Exercises the seam added in `src/engine/adopt.ts`: when a `LedgerDb` is
// wired, every `applyEffect` invocation whose verdict carries a structured
// `capabilityUse` record produces one row in `capability_uses` joined to
// the runtime-allocated `RunRecord.id`. Pinned by
// [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] §"Structural
// enforcement" §2.
//
// Real integration tests against `bun:sqlite` + a minimal git repo — the
// adoption loop reads `currentBranch` / `currentSha`; a stub runner
// produces the per-iteration effects.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adopt } from "../../src/engine/adopt";
import type { AdoptionPhaseRunner } from "../../src/engine/runner-contract";
import { noopSinks } from "../../src/engine/apply-effect";
import { patchEffect } from "../../src/core/effect";
import { commitOid } from "../../src/core/source-ref";
import { makeManualProposal } from "../../src/core/proposal";
import type { EngineVault } from "../../src/engine/vault-shape";
import { commit, initRepo, currentSha } from "../../src/git";
import type { Capability } from "../../src/core/processor";
import { openLedgerDb, type LedgerDb } from "../../src/ledger/db";
import { capabilityUsesByRun } from "../../src/ledger/capability-uses";
import type { RunId } from "../../src/ledger/runs";

type Fixture = {
  vault: EngineVault;
  ledger: LedgerDb;
  baseSha: string;
  cleanup: () => Promise<void>;
};

async function makeFixture(): Promise<Fixture> {
  const path = mkdtempSync(join(tmpdir(), "adopt-capuse-"));
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
      git: { auto_commit_workflows: true },
    },
  };
  const ledgerResult = await openLedgerDb({
    path: join(path, ".dome", "state", "runs.db"),
  });
  if (!ledgerResult.ok) {
    throw new Error(`openLedgerDb failed: ${ledgerResult.error.kind}`);
  }
  return {
    vault,
    ledger: ledgerResult.value.db,
    baseSha,
    cleanup: async () => {
      ledgerResult.value.db.close();
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

const RUN_ID = "run_test_capuse" as RunId;

describe("adopt — capability-use recording (Phase 6)", () => {
  test("PatchEffect (propose) with patch.propose granted → blocks adoption and records 'allowed' row", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const sha = await currentSha(f.vault.path);
    if (sha === null) throw new Error("expected sha");
    const proposal = makeManualProposal({
      id: "prop_capuse_1",
      base: commitOid(sha),
      head: commitOid(sha),
      branch: "main",
    });

    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
    const runner: AdoptionPhaseRunner = async () => [
      {
        runId: RUN_ID,
        processorId: "test.capuse.allowed",
        executionStatus: "succeeded",
        declared: [propose],
        granted: [propose],
        effects: [
          patchEffect({
            mode: "propose",
            changes: [
              { kind: "write", path: "wiki/seed.md", content: "x\n" },
            ],
            reason: "x",
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
      ledger: f.ledger,
    });

    expect(r.adopted).toBe(false);
    expect(
      r.diagnostics.some((d) => d.code === "patch.propose.requires-review"),
    ).toBe(true);

    const uses = capabilityUsesByRun(f.ledger, RUN_ID);
    expect(uses.length).toBe(1);
    const use = uses[0];
    if (use === undefined) throw new Error("expected capability use");
    expect(use.capability).toBe("patch.propose");
    expect(use.outcome).toBe("allowed");
    expect(use.resource).toBe("wiki/seed.md");
  });

  test("PatchEffect (auto) without patch.auto but with patch.propose → 'downgraded' row", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const sha = await currentSha(f.vault.path);
    if (sha === null) throw new Error("expected sha");
    const proposal = makeManualProposal({
      id: "prop_capuse_2",
      base: commitOid(sha),
      head: commitOid(sha),
      branch: "main",
    });

    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
    const runner: AdoptionPhaseRunner = async () => [
      {
        runId: RUN_ID,
        processorId: "test.capuse.downgraded",
        executionStatus: "succeeded",
        declared: [propose],
        granted: [propose],
        effects: [
          patchEffect({
            mode: "auto",
            changes: [
              { kind: "write", path: "wiki/seed.md", content: "y\n" },
            ],
            reason: "y",
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
      ledger: f.ledger,
    });

    expect(r.adopted).toBe(false);
    expect(
      r.diagnostics.some((d) => d.code === "patch.propose.requires-review"),
    ).toBe(true);

    const uses = capabilityUsesByRun(f.ledger, RUN_ID);
    expect(uses.length).toBe(1);
    const use = uses[0];
    if (use === undefined) throw new Error("expected capability use");
    expect(use.capability).toBe("patch.auto");
    expect(use.outcome).toBe("downgraded");
    expect(use.resource).toBe("wiki/seed.md");
  });

  test("PatchEffect (auto) with NO patch grants → 'denied' row + loop returns adopted=false", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const sha = await currentSha(f.vault.path);
    if (sha === null) throw new Error("expected sha");
    const proposal = makeManualProposal({
      id: "prop_capuse_3",
      base: commitOid(sha),
      head: commitOid(sha),
      branch: "main",
    });

    const runner: AdoptionPhaseRunner = async () => [
      {
        runId: RUN_ID,
        processorId: "test.capuse.denied",
        executionStatus: "succeeded",
        declared: [],
        granted: [],
        effects: [
          patchEffect({
            mode: "auto",
            changes: [
              { kind: "write", path: "wiki/seed.md", content: "z\n" },
            ],
            reason: "z",
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
      ledger: f.ledger,
    });

    expect(r.adopted).toBe(false);

    const uses = capabilityUsesByRun(f.ledger, RUN_ID);
    expect(uses.length).toBe(1);
    const use = uses[0];
    if (use === undefined) throw new Error("expected capability use");
    expect(use.capability).toBe("patch.auto");
    expect(use.outcome).toBe("denied");
    expect(use.resource).toBe("wiki/seed.md");
  });

  test("no ledger wired → adoption runs normally; no capability_uses written", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    const sha = await currentSha(f.vault.path);
    if (sha === null) throw new Error("expected sha");
    const proposal = makeManualProposal({
      id: "prop_capuse_4",
      base: commitOid(sha),
      head: commitOid(sha),
      branch: "main",
    });

    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
    const runner: AdoptionPhaseRunner = async () => [
      {
        runId: RUN_ID,
        processorId: "test.capuse.no-ledger",
        executionStatus: "succeeded",
        declared: [propose],
        granted: [propose],
        effects: [
          patchEffect({
            mode: "propose",
            changes: [
              { kind: "write", path: "wiki/seed.md", content: "no-ledger\n" },
            ],
            reason: "no-ledger",
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
      // ledger intentionally absent
    });

    expect(r.adopted).toBe(false);

    // The fixture's ledger was opened but not threaded through `adopt` —
    // so it sees zero rows.
    expect(capabilityUsesByRun(f.ledger, RUN_ID).length).toBe(0);
  });
});
