// Garden sub-Proposal 3-way-merge plumbing.
//
// Proves that `spawnGardenSubProposal` forwards the emitting processor's read
// snapshot as `mergeBase` to `applyPatchToCandidate`, so two garden patches
// that write DISJOINT regions of one file from the SAME read snapshot both
// survive — the second does NOT revert the first.
//
// This is the production non-converging loop fix: `dome.claims.render-facts`
// and `dome.claims.stamp` each emit a whole-file write from the same read
// snapshot; without mergeBase plumbing the second overwrites the first's
// region forever. Real git + real applyPatchToCandidate; the only stub is
// `adoptSubProposal` (we don't need adoption to actually run).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fs from "node:fs";
import git from "isomorphic-git";

import { spawnGardenSubProposal } from "../../src/engine/garden/garden-sub-proposals";
import { runGardenPhase } from "../../src/engine/garden/garden";
import { applyPatchToCandidate } from "../../src/engine/core/apply-patch";
import { noopSinks } from "../../src/engine/core/apply-effect";
import { patchEffect } from "../../src/core/effect";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import { makeManualProposal } from "../../src/core/proposal";
import type { AdoptionResult, Proposal } from "../../src/core/proposal";
import type { Capability } from "../../src/core/processor";
import type { RunId } from "../../src/engine/core/runner-contract";
import type { EngineVault } from "../../src/engine/core/vault-shape";
import { commit, initRepo } from "../../src/git";
import type { LedgerDb } from "../../src/ledger/db";
import { insertQueued } from "../../src/ledger/runs";
import { openTestLedger } from "../support/test-ledger";

let ledger: LedgerDb;
beforeAll(async () => {
  ledger = await openTestLedger();
  // capability_uses joins to a run row by runId — the conflict test routes
  // patch effects through runGardenPhase under a single shared RUN_ID, so
  // seed that run row to satisfy the FK constraint.
  insertQueued(ledger, {
    id: RUN_ID,
    proposalId: null,
    processorId: "dome.claims.render-facts",
    processorVersion: "0.0.1",
    phase: "garden",
    inputCommit: commitOid("0".repeat(40)),
    triggerKind: "signal",
    triggerPayload: null,
    startedAt: new Date(),
  });
});
afterAll(() => {
  ledger.close();
});

type Fixture = {
  readonly vaultPath: string;
  readonly snapshot: CommitOid;
  readonly cleanup: () => Promise<void>;
};

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

async function makeFixture(content: string): Promise<Fixture> {
  const path = mkdtempSync(join(tmpdir(), "garden-merge-"));
  await initRepo(path);
  await writeFile(join(path, "daily.md"), content);
  const sha = await commit({ path, message: "init\n", files: ["daily.md"] });
  return {
    vaultPath: path,
    snapshot: commitOid(sha),
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

async function readBlobAt(
  vaultPath: string,
  oid: string,
  filepath: string,
): Promise<string | null> {
  try {
    const result = await git.readBlob({ fs, dir: vaultPath, oid, filepath });
    return Buffer.from(result.blob).toString("utf8");
  } catch {
    return null;
  }
}

const MINIMAL_ADOPTION = (proposal: Proposal): AdoptionResult =>
  Object.freeze({
    proposalId: proposal.id,
    adopted: true,
    adoptedRef: proposal.head,
    diagnostics: [],
    closureCommitOid: null,
    iterations: 1,
  });

function vaultFor(path: string): EngineVault {
  return Object.freeze({
    path,
    config: Object.freeze({
      git: Object.freeze({ auto_commit_workflows: true }),
    }),
  });
}

const RUN_ID = "run_1700000000000_abcdef" as RunId;

/**
 * Spawn one garden sub-Proposal with the real applyPatchToCandidate and a
 * stub adoptSubProposal. Returns the applied head (proposal.head).
 */
async function spawnWrite(opts: {
  readonly vaultPath: string;
  readonly base: CommitOid;
  readonly mergeBase: CommitOid;
  readonly content: string;
  readonly reason: string;
}): Promise<CommitOid> {
  const patch = patchEffect({
    mode: "auto",
    changes: [{ kind: "write", path: "daily.md", content: opts.content }],
    reason: opts.reason,
    sourceRefs: [],
  });
  const result = await spawnGardenSubProposal({
    vault: vaultFor(opts.vaultPath),
    base: opts.base,
    mergeBase: opts.mergeBase,
    sourceHead: opts.base,
    patch,
    processorId: `dome.claims.${opts.reason}`,
    runId: RUN_ID,
    extensionId: "dome.claims",
    cascadeDepth: 1,
    maxCascadeDepth: 10,
    applyPatch: applyPatchToCandidate,
    adoptSubProposal: async (proposal) => MINIMAL_ADOPTION(proposal),
  });
  if (result.kind !== "spawned") {
    throw new Error(`expected spawned, got ${result.kind}`);
  }
  return result.proposal.head;
}

const S0 = "TOP: base\nm1\nm2\nm3\nBOTTOM: base\n";
const A_CONTENT = "TOP: from-A\nm1\nm2\nm3\nBOTTOM: base\n"; // TOP changed only
const B_CONTENT = "TOP: base\nm1\nm2\nm3\nBOTTOM: from-B\n"; // BOTTOM changed only

describe("spawnGardenSubProposal mergeBase plumbing", () => {
  test("disjoint-region writes from the same read snapshot both survive", async () => {
    const f = await makeFixture(S0);
    fixtures.push(f);
    const s0 = f.snapshot;

    // Spawn #1 (render-like): base === mergeBase === s0 → overwrite. TOP changes.
    const h1 = await spawnWrite({
      vaultPath: f.vaultPath,
      base: s0,
      mergeBase: s0,
      content: A_CONTENT,
      reason: "render-facts",
    });
    expect(await readBlobAt(f.vaultPath, h1, "daily.md")).toBe(A_CONTENT);

    // Spawn #2 (stamp-like): the live candidate advanced to H1 (sibling #1
    // adopted), but the stamp processor READ s0 → mergeBase = s0, base = H1.
    // Disjoint region → 3-way merge keeps BOTH changes.
    const h2 = await spawnWrite({
      vaultPath: f.vaultPath,
      base: h1,
      mergeBase: s0,
      content: B_CONTENT,
      reason: "stamp",
    });

    const merged = await readBlobAt(f.vaultPath, h2, "daily.md");
    expect(merged).toContain("TOP: from-A"); // A's region survived
    expect(merged).toContain("BOTTOM: from-B"); // B's region landed
  });

  test("true conflict (same region edited from same snapshot) fires onMergeConflict", async () => {
    const f = await makeFixture(S0);
    fixtures.push(f);
    const s0 = f.snapshot;

    // Spawn #1 edits the TOP line.
    const h1 = await spawnWrite({
      vaultPath: f.vaultPath,
      base: s0,
      mergeBase: s0,
      content: A_CONTENT,
      reason: "render-facts",
    });
    expect(await readBlobAt(f.vaultPath, h1, "daily.md")).toBe(A_CONTENT);

    // Spawn #2 edits the SAME TOP line (conflict) AND a disjoint BOTTOM line
    // (clean) from the SAME snapshot (s0). base advanced to H1 (sibling #1
    // landed); mergeBase = s0 → the TOP region truly conflicts → resolves to
    // `ours` (H1's TOP) and fires onMergeConflict once; BOTTOM merges cleanly so
    // the merged tree differs from H1 and the sub-Proposal actually spawns.
    const collected: Array<{ path: string; processorId: string }> = [];
    const CONFLICTING = "TOP: from-B\nm1\nm2\nm3\nBOTTOM: from-B\n"; // TOP conflicts, BOTTOM clean
    const patch = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "daily.md", content: CONFLICTING }],
      reason: "stamp",
      sourceRefs: [],
    });
    const result = await spawnGardenSubProposal({
      vault: vaultFor(f.vaultPath),
      base: h1,
      mergeBase: s0,
      sourceHead: h1,
      patch,
      processorId: "dome.claims.stamp",
      runId: RUN_ID,
      extensionId: "dome.claims",
      cascadeDepth: 1,
      maxCascadeDepth: 10,
      applyPatch: applyPatchToCandidate,
      adoptSubProposal: async (proposal) => MINIMAL_ADOPTION(proposal),
      onMergeConflict: (info) => collected.push(info),
    });
    if (result.kind !== "spawned") {
      throw new Error(`expected spawned, got ${result.kind}`);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0]?.path).toBe("daily.md");
    expect(collected[0]?.processorId).toBe("dome.claims.stamp");
  });

  test("orchestrator records a garden.patch.merge-conflict diagnostic on a true conflict", async () => {
    const f = await makeFixture(S0);
    fixtures.push(f);
    const s0 = f.snapshot;

    // Simulate the live adopted ref advancing as each sub-Proposal adopts —
    // what the real host's currentAdopted observes across the spawn loop.
    let liveAdopted: CommitOid = s0;

    const recorded: Array<{ code: string; processorId: string }> = [];
    const sinks = {
      ...noopSinks(),
      recordDiagnostic: async (input: {
        readonly effect: { readonly code: string };
        readonly processorId: string;
      }) => {
        recorded.push({ code: input.effect.code, processorId: input.processorId });
      },
    };

    const grant: Capability[] = [
      { kind: "read", paths: ["daily.md"] },
      { kind: "patch.auto", paths: ["daily.md"] },
    ];
    const runnerResult = (processorId: string, content: string) => ({
      runId: RUN_ID,
      processorId,
      executionStatus: "succeeded" as const,
      declared: grant,
      granted: grant,
      inspectedPaths: ["daily.md"],
      effects: [
        patchEffect({
          mode: "auto",
          changes: [{ kind: "write", path: "daily.md", content }],
          reason: processorId,
          sourceRefs: [],
        }),
      ],
    });

    const result = await runGardenPhase({
      vault: vaultFor(f.vaultPath),
      proposal: makeManualProposal({
        id: "prop_conflict",
        base: s0,
        head: s0,
        branch: "main",
      }),
      adopted: s0,
      changedPaths: ["daily.md"],
      signals: [{ signal: "document.changed", path: "daily.md" }],
      currentAdopted: () => liveAdopted,
      runGardenProcessors: async () => [
        // #1 changes TOP only.
        runnerResult("dome.claims.render-facts", A_CONTENT),
        // #2 read the SAME snapshot (s0) but the candidate advanced to #1's
        // head; it conflicts on TOP and changes BOTTOM cleanly.
        runnerResult("dome.claims.stamp", "TOP: from-B\nm1\nm2\nm3\nBOTTOM: from-B\n"),
      ],
      sinks,
      ledger,
      adoptSubProposal: async (proposal) => {
        liveAdopted = proposal.head; // advance the live ref as the host would
        return MINIMAL_ADOPTION(proposal);
      },
    });

    const conflicts = recorded.filter(
      (r) => r.code === "garden.patch.merge-conflict",
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.processorId).toBe("dome.claims.stamp");
    expect(
      result.diagnostics.some((d) => d.code === "garden.patch.merge-conflict"),
    ).toBe(true);
  });

  test("gate: mergeBase === base (=== H1) is a plain overwrite that reverts TOP", async () => {
    const f = await makeFixture(S0);
    fixtures.push(f);
    const s0 = f.snapshot;

    const h1 = await spawnWrite({
      vaultPath: f.vaultPath,
      base: s0,
      mergeBase: s0,
      content: A_CONTENT,
      reason: "render-facts",
    });

    // mergeBase === base (H1) → no sibling divergence to reconcile → overwrite.
    const h2 = await spawnWrite({
      vaultPath: f.vaultPath,
      base: h1,
      mergeBase: h1,
      content: B_CONTENT,
      reason: "stamp",
    });

    const result = await readBlobAt(f.vaultPath, h2, "daily.md");
    expect(result).toBe(B_CONTENT); // verbatim overwrite
    expect(result).toContain("TOP: base"); // A's TOP reverted
  });
});
