// Crash-safety tests for adoption finalization (src/engine/finalize-journal.ts).
//
// The crash window: `adopt()` advances `refs/heads/<branch>` to the engine
// target, then materializes changed paths into the working tree. A process
// death between those two steps used to leave a stale working tree that the
// next tick never repaired (refs look in-sync, so materialization is
// skipped) — the stale content then read as phantom user edits.
//
// Fault injection here constructs the exact post-crash states directly
// (branch ref settled on one side of the move, working tree holding the
// other side's content, journal present) and asserts replay repairs them —
// including the mid-rollback crash direction — while preserving content a
// human wrote after the crash.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clearFinalizeJournal,
  finalizeJournalPath,
  replayFinalizeJournal,
  writeFinalizeJournal,
} from "../../src/engine/finalize-journal";
import { adopt } from "../../src/engine/adopt";
import { applyPatchToCandidate } from "../../src/engine/apply-patch";
import type {
  AdoptionPhaseRunner,
  RunId,
} from "../../src/engine/runner-contract";
import { noopSinks } from "../../src/engine/apply-effect";
import { patchEffect } from "../../src/core/effect";
import { commitOid } from "../../src/core/source-ref";
import { makeManualProposal } from "../../src/core/proposal";
import type { EngineVault } from "../../src/engine/vault-shape";
import { commit, currentSha, initRepo, readRef, writeRef } from "../../src/git";
import { openVaultRuntime } from "../../src/engine/vault-runtime";
import { runCompilerHostTick } from "../../src/engine/compiler-host";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");

const SOURCE_CONTENT = "---\ntype: concept\n---\n\n# Page\n\nsource\n";
const ENGINE_CONTENT = "---\ntype: concept\n---\n\n# Page\n\nengine\n";

type Fixture = {
  vaultPath: string;
  baseSha: string;
  targetSha: string;
  cleanup: () => Promise<void>;
};

/**
 * A repo where commit B (source content) is the parent of commit T (engine
 * content); the branch ends at T with the working tree matching T.
 * Individual tests then rearrange refs/tree/journal into post-crash shapes.
 */
async function makeCrashFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "finalize-journal-"));
  await initRepo(vaultPath);
  await mkdir(join(vaultPath, "wiki"), { recursive: true });
  await writeFile(join(vaultPath, "wiki/seed.md"), SOURCE_CONTENT);
  const baseSha = await commit({
    path: vaultPath,
    message: "source\n",
    files: ["wiki/seed.md"],
  });
  await writeFile(join(vaultPath, "wiki/seed.md"), ENGINE_CONTENT);
  const targetSha = await commit({
    path: vaultPath,
    message: "engine target\n",
    files: ["wiki/seed.md"],
  });
  return {
    vaultPath,
    baseSha,
    targetSha,
    cleanup: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

async function journalFor(f: Fixture): Promise<void> {
  await writeFinalizeJournal(f.vaultPath, {
    branch: "main",
    sourceHead: f.baseSha,
    target: f.targetSha,
    paths: ["wiki/seed.md"],
    writtenAt: new Date().toISOString(),
  });
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

describe("finalize-journal replay", () => {
  test("crash after branch advance, before materialization → replay restores the target content", async () => {
    const f = await makeCrashFixture();
    fixtures.push(f);
    // Post-crash state: branch at target, working tree still at source.
    await writeFile(join(f.vaultPath, "wiki/seed.md"), SOURCE_CONTENT);
    await journalFor(f);

    const result = await replayFinalizeJournal(f.vaultPath);

    expect(result.kind).toBe("replayed");
    if (result.kind !== "replayed") return;
    expect(result.settled).toBe("target");
    expect([...result.restoredPaths]).toEqual(["wiki/seed.md"]);
    expect([...result.skippedPaths]).toEqual([]);
    const content = await Bun.file(join(f.vaultPath, "wiki/seed.md")).text();
    expect(content).toBe(ENGINE_CONTENT);
    expect(existsSync(finalizeJournalPath(f.vaultPath))).toBe(false);
  });

  test("crash mid-rollback (branch back at source head, tree at engine content) → replay restores the source content", async () => {
    const f = await makeCrashFixture();
    fixtures.push(f);
    await writeRef({
      path: f.vaultPath,
      ref: "refs/heads/main",
      value: f.baseSha,
    });
    // Tree still holds the half-materialized engine content.
    await writeFile(join(f.vaultPath, "wiki/seed.md"), ENGINE_CONTENT);
    await journalFor(f);

    const result = await replayFinalizeJournal(f.vaultPath);

    expect(result.kind).toBe("replayed");
    if (result.kind !== "replayed") return;
    expect(result.settled).toBe("source-head");
    expect([...result.restoredPaths]).toEqual(["wiki/seed.md"]);
    const content = await Bun.file(join(f.vaultPath, "wiki/seed.md")).text();
    expect(content).toBe(SOURCE_CONTENT);
  });

  test("human edit after the crash is preserved and reported, journal still cleared", async () => {
    const f = await makeCrashFixture();
    fixtures.push(f);
    await writeFile(
      join(f.vaultPath, "wiki/seed.md"),
      "post-crash hand edit\n",
    );
    await journalFor(f);

    const result = await replayFinalizeJournal(f.vaultPath);

    expect(result.kind).toBe("replayed");
    if (result.kind !== "replayed") return;
    expect([...result.restoredPaths]).toEqual([]);
    expect([...result.skippedPaths]).toEqual(["wiki/seed.md"]);
    const content = await Bun.file(join(f.vaultPath, "wiki/seed.md")).text();
    expect(content).toBe("post-crash hand edit\n");
    expect(existsSync(finalizeJournalPath(f.vaultPath))).toBe(false);
  });

  test("working tree already consistent with the settled side → replay is a no-op", async () => {
    const f = await makeCrashFixture();
    fixtures.push(f);
    await journalFor(f); // branch at target, tree already at target content

    const result = await replayFinalizeJournal(f.vaultPath);

    expect(result.kind).toBe("replayed");
    if (result.kind !== "replayed") return;
    expect([...result.restoredPaths]).toEqual([]);
    expect([...result.skippedPaths]).toEqual([]);
  });

  test("branch moved past both sides → journal superseded and cleared, tree untouched", async () => {
    const f = await makeCrashFixture();
    fixtures.push(f);
    await writeFile(join(f.vaultPath, "wiki/seed.md"), "later work\n");
    const laterSha = await commit({
      path: f.vaultPath,
      message: "later\n",
      files: ["wiki/seed.md"],
    });
    await journalFor(f);

    const result = await replayFinalizeJournal(f.vaultPath);

    expect(result.kind).toBe("superseded");
    expect(await readRef({ path: f.vaultPath, ref: "refs/heads/main" }))
      .toBe(laterSha);
    const content = await Bun.file(join(f.vaultPath, "wiki/seed.md")).text();
    expect(content).toBe("later work\n");
    expect(existsSync(finalizeJournalPath(f.vaultPath))).toBe(false);
  });

  test("malformed journal is cleared without touching the tree", async () => {
    const f = await makeCrashFixture();
    fixtures.push(f);
    await mkdir(join(f.vaultPath, ".dome", "state"), { recursive: true });
    await writeFile(finalizeJournalPath(f.vaultPath), "{not json");

    const result = await replayFinalizeJournal(f.vaultPath);

    expect(result.kind).toBe("cleared-invalid");
    expect(existsSync(finalizeJournalPath(f.vaultPath))).toBe(false);
  });

  test("no journal → none", async () => {
    const f = await makeCrashFixture();
    fixtures.push(f);
    expect((await replayFinalizeJournal(f.vaultPath)).kind).toBe("none");
  });
});

describe("finalize-journal lifecycle in adopt()", () => {
  test("successful adoption with a branch advance leaves no journal behind", async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "finalize-adopt-"));
    const cleanup = async (): Promise<void> => {
      await rm(vaultPath, { recursive: true, force: true });
    };
    fixtures.push({
      vaultPath,
      baseSha: "",
      targetSha: "",
      cleanup,
    });
    await initRepo(vaultPath);
    await mkdir(join(vaultPath, "wiki"), { recursive: true });
    await writeFile(join(vaultPath, "wiki/seed.md"), "seed\n");
    await commit({ path: vaultPath, message: "init\n", files: ["wiki/seed.md"] });
    const sha = await currentSha(vaultPath);
    if (sha === null) throw new Error("expected sha");

    const vault: EngineVault = {
      path: vaultPath,
      config: { git: { auto_commit_workflows: true } },
    };
    const proposal = makeManualProposal({
      id: "prop_finalize_journal",
      base: commitOid(sha),
      head: commitOid(sha),
      branch: "main",
    });
    const auto = { kind: "patch.auto" as const, paths: ["wiki/**"] };
    let ran = false;
    const runner: AdoptionPhaseRunner = async () => {
      if (ran) return [];
      ran = true;
      return [
        {
          runId: "run_finalize_journal" as RunId,
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
      vault,
      proposal,
      runAdoptionProcessors: runner,
      sinks: {
        ...noopSinks(),
        applyPatch: async ({ effect, processorId, runId, candidate }) =>
          applyPatchToCandidate({
            vaultPath,
            candidate,
            patch: effect,
            runContext: {
              runId,
              processorId,
              extensionId: "test",
              base: proposal.base,
              sourceHead: commitOid(sha),
            },
          }),
      },
    });

    expect(r.adopted).toBe(true);
    expect(r.closureCommitOid).not.toBeNull();
    // The branch advanced and the tree materialized; the intent is resolved.
    expect(existsSync(finalizeJournalPath(vaultPath))).toBe(false);
    const content = await Bun.file(join(vaultPath, "wiki/seed.md")).text();
    expect(content).toBe("engine\n");
  });
});

describe("finalize-journal replay through the compiler-host tick", () => {
  test("a tick repairs the crash window before doing new work", async () => {
    const f = await makeCrashFixture();
    fixtures.push(f);
    // Refs fully advanced (branch + adopted at target) but the working tree
    // was never materialized — the exact state a crash between writeRef and
    // materializeBranchTarget leaves when the adopted ref also landed, or
    // that a prior replay never saw because the host stayed down.
    await writeRef({
      path: f.vaultPath,
      ref: "refs/dome/adopted/main",
      value: f.targetSha,
    });
    await writeFile(join(f.vaultPath, "wiki/seed.md"), SOURCE_CONTENT);
    await journalFor(f);

    await mkdir(join(f.vaultPath, ".dome", "state"), { recursive: true });
    await writeFile(
      join(f.vaultPath, ".dome", "config.yaml"),
      "extensions:\n  dome.markdown:\n    enabled: true\n    grant:\n      read:\n        - \"**/*.md\"\n",
    );
    const runtimeResult = await openVaultRuntime({
      vaultPath: f.vaultPath,
      bundlesRoot: SHIPPED_BUNDLES_ROOT,
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    try {
      const tick = await runCompilerHostTick({
        runtime: runtimeResult.value,
        runOperationalWhenInSync: false,
      });
      expect(tick.kind).toBe("in-sync");
      const content = await Bun.file(join(f.vaultPath, "wiki/seed.md")).text();
      expect(content).toBe(ENGINE_CONTENT);
      expect(existsSync(finalizeJournalPath(f.vaultPath))).toBe(false);
    } finally {
      await runtimeResult.value.close();
    }
  });
});
