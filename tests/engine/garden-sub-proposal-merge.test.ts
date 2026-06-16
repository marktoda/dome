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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fs from "node:fs";
import git from "isomorphic-git";

import { spawnGardenSubProposal } from "../../src/engine/garden/garden-sub-proposals";
import { applyPatchToCandidate } from "../../src/engine/core/apply-patch";
import { patchEffect } from "../../src/core/effect";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import type { AdoptionResult, Proposal } from "../../src/core/proposal";
import type { RunId } from "../../src/engine/core/runner-contract";
import type { EngineVault } from "../../src/engine/core/vault-shape";
import { commit, initRepo } from "../../src/git";

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
