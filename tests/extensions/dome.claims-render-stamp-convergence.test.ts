// dome.claims render-facts <-> stamp whole-file write composition.
//
// Two garden processors in the dome.claims bundle edit the SAME page in the
// SAME garden pass against the SAME adopted snapshot S0:
//   - dome.claims.stamp     -> whole-file write = S0 + `^c…` anchors on claim
//                              source lines (no digest block).
//   - dome.claims.render-facts -> whole-file write = S0 + a `## Current facts`
//                              digest block after frontmatter/H1. The digest
//                              predicts the same deterministic `^c…` anchors
//                              stamp will apply, so backlinks are already at
//                              the post-stamp fixed point.
//
// These two writes edit DISJOINT regions of S0. Pre-fix, applyPatchToCandidate
// overwrote: the second write reverts the first's region, and the two
// processors fight forever. The merge fix makes applyPatchToCandidate 3-way
// merge a write against `runContext.mergeBase` (= the snapshot the processor
// read), so disjoint regions COMPOSE. The render-side anchor prediction then
// removes the extra "render again to add backlinks" cascade.
//
// This test reproduces the stale-read / advanced-candidate condition the
// end-to-end harness cannot (the harness re-reads fresh state each cascade
// round and converges even pre-fix). The two whole-file writes here come from
// the REAL claims processor logic (claims-shared `stampClaimAnchors` +
// render-facts `renderCurrentFactsBlock` + the exported `insertBlock` /
// `insertionOffset` splice), so they are the exact PatchEffect contents the
// processors would emit.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fs from "node:fs";
import git from "isomorphic-git";

import { applyPatchToCandidate } from "../../src/engine/core/apply-patch";
import { patchEffect } from "../../src/core/effect";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import { commit, initRepo } from "../../src/git";
import {
  claimsFromMarkdown,
  claimsWithStableAnchors,
  stampClaimAnchors,
} from "../../assets/extensions/dome.claims/processors/claims-shared";
import {
  insertBlock,
  insertionOffset,
  renderCurrentFactsBlock,
} from "../../assets/extensions/dome.claims/processors/render-facts";

// ----- fixture --------------------------------------------------------------

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

const PATH = "notes/2026-06-16.md";

// S0: frontmatter + H1 + 3 un-anchored claim lines + prose. The claim lines
// sit BELOW the H1, so render's after-H1 splice and stamp's on-claim-line
// anchors touch disjoint regions.
const S0 = [
  "---",
  "title: Standup",
  "---",
  "# Standup 2026-06-16",
  "",
  "Some intro prose about the day.",
  "",
  "- **Status:** Active",
  "- **Owner:** [[Mark]]",
  "- **Stage:** Build",
  "",
  "Closing prose paragraph.",
  "",
].join("\n");

async function makeFixture(content: string): Promise<Fixture> {
  const path = mkdtempSync(join(tmpdir(), "claims-conv-"));
  await initRepo(path);
  await fs.promises.mkdir(join(path, "notes"), { recursive: true });
  await writeFile(join(path, PATH), content);
  const sha = await commit({ path, message: "init\n", files: [PATH] });
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

// ----- patch / runContext builders ------------------------------------------

const ANCHOR_RE = /\^c[0-9a-f]{8}/;
const DIGEST_START = "<!-- dome.claims:current-facts:start -->";
const DIGEST_HEADING = "## Current facts";

function writePatch(content: string, reason: string) {
  return patchEffect({
    mode: "auto",
    changes: [{ kind: "write", path: PATH, content }],
    reason,
    sourceRefs: [],
  });
}

function runContext(opts: { base: CommitOid; mergeBase: CommitOid }) {
  return {
    runId: "run_1700000000000_abcdef",
    processorId: "dome.claims.test",
    extensionId: "dome.claims",
    base: opts.base,
    sourceHead: opts.base,
    mergeBase: opts.mergeBase,
  };
}

// Faithful render whole-file write against a given snapshot, using the REAL
// render-facts pure functions + the EXACT splice the processor uses.
function renderWholeFile(content: string): string {
  const claims = claimsWithStableAnchors({ path: PATH, content });
  const page = PATH.replace(/\.md$/, "");
  const block = renderCurrentFactsBlock(claims, page);
  return insertBlock(content, block, insertionOffset(content));
}

// ----- tests ----------------------------------------------------------------

describe("dome.claims render-facts <-> stamp whole-file write composition", () => {
  test("disjoint writes compose; both anchors and digest survive (stamp first, render second)", async () => {
    const f = await makeFixture(S0);
    fixtures.push(f);
    const s0 = f.snapshot;

    // ---- stamp's whole-file write (REAL function) ----
    const stampContent = stampClaimAnchors({ path: PATH, content: S0 });
    expect(stampContent).not.toBeNull();
    expect(stampContent!).toMatch(ANCHOR_RE);
    expect(stampContent!).not.toContain(DIGEST_START); // stamp adds no digest

    // ---- render's whole-file write (REAL render logic against S0) ----
    const renderContent = renderWholeFile(S0);
    expect(renderContent).toContain(DIGEST_START);
    expect(renderContent).toContain(DIGEST_HEADING);
    // render read S0: claim SOURCE lines stay un-anchored, but the digest
    // predicts the anchors stamp will apply and is already backlink-complete.
    expect(renderContent).toContain(`([[${PATH.replace(/\.md$/, "")}#^`);
    expect(
      claimsFromMarkdown(renderContent).filter((claim) => claim.anchor !== null),
    ).toHaveLength(0);

    // Disjoint: distinct contents, distinct edited regions.
    expect(renderContent).not.toBe(stampContent!);

    // ---- cascade: stamp lands first onto s0 (mergeBase=s0=candidate -> overwrite)
    const a1 = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: s0,
      patch: writePatch(stampContent!, "stamp"),
      runContext: runContext({ base: s0, mergeBase: s0 }),
    });
    expect(a1).not.toBeNull();

    // render lands second onto the ADVANCED candidate a1, but it READ s0 ->
    // mergeBase = s0, candidate = a1. Disjoint -> 3-way merge keeps BOTH.
    const a2 = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: a1!,
      patch: writePatch(renderContent, "render"),
      runContext: runContext({ base: a1!, mergeBase: s0 }),
    });
    expect(a2).not.toBeNull();

    const merged = await readBlobAt(f.vaultPath, a2!, PATH);
    expect(merged).not.toBeNull();

    // CORE: both survived (pre-fix the second write reverts the first's region).
    expect(merged!).toMatch(ANCHOR_RE); // stamp's anchors survived
    expect(merged!).toContain(DIGEST_START); // render's digest survived
    expect(merged!).toContain(DIGEST_HEADING);
    // All three claim keys still present, now anchored.
    expect(claimsFromMarkdown(merged!).filter((c) => c.anchor !== null)).toHaveLength(3);

    // ---- convergence / fixed point ----
    // stamp is now a no-op: every claim source line is already anchored.
    expect(stampClaimAnchors({ path: PATH, content: merged! })).toBeNull();

    // re-render is stable: because render predicted the same anchors stamp
    // applied, re-splicing the digest into `merged` is byte-stable. No extra
    // cascade is needed just to add backlinks.
    const { replaceGeneratedBlock } = await import(
      "../../src/core/generated-block"
    );
    const claimsAfter = claimsFromMarkdown(merged!);
    expect(claimsAfter.every((c) => c.anchor !== null)).toBe(true);
    const rerenderedBlock = renderCurrentFactsBlock(
      claimsAfter,
      PATH.replace(/\.md$/, ""),
    );
    // anchored claims -> the digest body carries page#^anchor backlinks.
    expect(rerenderedBlock).toContain(`([[${PATH.replace(/\.md$/, "")}#^`);
    const rerendered = replaceGeneratedBlock(
      merged!,
      "dome.claims",
      "current-facts",
      rerenderedBlock,
    );
    expect(rerendered).toBe(merged);
    // The digest + anchors coexist; re-rendering does not strip the anchors and
    // a second re-render is byte-stable (true fixed point).
    expect(rerendered).toMatch(ANCHOR_RE);
    expect(rerendered).toContain(DIGEST_HEADING);
    const rerendered2 = replaceGeneratedBlock(
      rerendered!,
      "dome.claims",
      "current-facts",
      renderCurrentFactsBlock(claimsFromMarkdown(rerendered!), PATH.replace(/\.md$/, "")),
    );
    expect(rerendered2).toBe(rerendered);
  });

  test("order-independent: render lands first, stamp second; both still survive", async () => {
    const f = await makeFixture(S0);
    fixtures.push(f);
    const s0 = f.snapshot;

    const stampContent = stampClaimAnchors({ path: PATH, content: S0 })!;
    const renderContent = renderWholeFile(S0);

    // render first onto s0 (overwrite) -> a1
    const a1 = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: s0,
      patch: writePatch(renderContent, "render"),
      runContext: runContext({ base: s0, mergeBase: s0 }),
    });
    expect(a1).not.toBeNull();

    // stamp second onto advanced candidate a1, mergeBase=s0 -> 3-way merge.
    const a2 = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: a1!,
      patch: writePatch(stampContent, "stamp"),
      runContext: runContext({ base: a1!, mergeBase: s0 }),
    });
    expect(a2).not.toBeNull();

    const merged = await readBlobAt(f.vaultPath, a2!, PATH);
    expect(merged).not.toBeNull();
    expect(merged!).toMatch(ANCHOR_RE); // stamp's anchors survived
    expect(merged!).toContain(DIGEST_START); // render's digest survived
    expect(merged!).toContain(DIGEST_HEADING);
    expect(stampClaimAnchors({ path: PATH, content: merged! })).toBeNull();
  });
});
