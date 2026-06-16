// Phase 12a — `applyPatchToCandidate` candidate-tree mutator tests.
//
// Exercises the `src/engine/core/apply-patch.ts` plumbing primitive against a
// real git repo: build a candidate commit, hand it to the function with a
// PatchEffect carrying a list of FileChange entries (whole-content writes /
// deletes), assert the returned new-candidate OID's tree carries the
// expected blobs + the commit message carries the four `Dome-*` trailers.
//
// The function is pure plumbing — it never touches the working tree, only
// the object database. Each assertion reads back via `git.readTree` /
// `git.readBlob` / `git.readCommit` to verify what landed.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fs from "node:fs";
import git from "isomorphic-git";

import { applyPatchToCandidate } from "../../src/engine/core/apply-patch";
import {
  PatchEffectSchema,
  patchEffect,
  type FileChangeInput,
} from "../../src/core/effect";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import { commit, initRepo } from "../../src/git";

type Fixture = {
  readonly vaultPath: string;
  readonly baseCandidate: CommitOid;
  readonly cleanup: () => Promise<void>;
};

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

async function makeFixture(seedFiles: Record<string, string>): Promise<Fixture> {
  const path = mkdtempSync(join(tmpdir(), "apply-patch-"));
  await initRepo(path);
  const filenames: string[] = [];
  for (const [relPath, content] of Object.entries(seedFiles)) {
    const full = join(path, relPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
    filenames.push(relPath);
  }
  const baseSha = await commit({
    path,
    message: "init\n",
    files: filenames,
  });
  return {
    vaultPath: path,
    baseCandidate: commitOid(baseSha),
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

const RUN_CONTEXT_FIXTURE = (base: CommitOid, head: CommitOid) => ({
  runId: "run_1700000000000_abcdef",
  processorId: "test.proc",
  extensionId: "test.bundle",
  base,
  sourceHead: head,
});

/**
 * Resolve a blob's UTF-8 content at a given commit OID + path. Returns null
 * when the path doesn't exist in the commit's tree. Test-side helper —
 * the production code has its own readBlob wrapper.
 */
async function readBlobAt(
  vaultPath: string,
  commitOidValue: string,
  filepath: string,
): Promise<string | null> {
  try {
    const result = await git.readBlob({
      fs,
      dir: vaultPath,
      oid: commitOidValue,
      filepath,
    });
    return Buffer.from(result.blob).toString("utf8");
  } catch {
    return null;
  }
}

describe("applyPatchToCandidate", () => {
  test("empty changes list is rejected by PatchEffectSchema validation", () => {
    // PatchEffectSchema enforces `.min(1)` — constructing via the parser
    // surface (the only boundary that validates) throws on an empty list.
    // The constructor helper `patchEffect()` itself is unvalidated by
    // design (matches the source-ref.ts pattern), so this test asserts the
    // schema layer rather than the helper.
    expect(() =>
      PatchEffectSchema.parse({
        kind: "patch",
        mode: "auto",
        changes: [],
        reason: "empty",
        sourceRefs: [],
      }),
    ).toThrow();
  });

  test("single-file write produces a new commit with modified content", async () => {
    const f = await makeFixture({
      "wiki/a.md": "line1\nline2\nline3\n",
      "wiki/b.md": "unchanged\n",
    });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [
        {
          kind: "write",
          path: "wiki/a.md",
          content: "line1\nline2-modified\nline3\n",
        },
      ],
      reason: "modify line2",
      sourceRefs: [],
    });

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
    });

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected new commit");

    // Modified file has new content.
    const modified = await readBlobAt(f.vaultPath, result, "wiki/a.md");
    expect(modified).toBe("line1\nline2-modified\nline3\n");

    // Unchanged file is unchanged.
    const unchanged = await readBlobAt(f.vaultPath, result, "wiki/b.md");
    expect(unchanged).toBe("unchanged\n");
  });

  test("multi-file write updates each touched path", async () => {
    const f = await makeFixture({
      "wiki/a.md": "alpha\n",
      "wiki/b.md": "beta\n",
    });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [
        { kind: "write", path: "wiki/a.md", content: "alpha-new\n" },
        { kind: "write", path: "wiki/b.md", content: "beta-new\n" },
      ],
      reason: "modify both",
      sourceRefs: [],
    });

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
    });

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected new commit");

    expect(await readBlobAt(f.vaultPath, result, "wiki/a.md")).toBe(
      "alpha-new\n",
    );
    expect(await readBlobAt(f.vaultPath, result, "wiki/b.md")).toBe(
      "beta-new\n",
    );
  });

  test("file creation adds new path to the tree", async () => {
    const f = await makeFixture({ "wiki/a.md": "existing\n" });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [
        {
          kind: "write",
          path: "wiki/new.md",
          content: "new line 1\nnew line 2\n",
        },
      ],
      reason: "create file",
      sourceRefs: [],
    });

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
    });

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected new commit");

    const created = await readBlobAt(f.vaultPath, result, "wiki/new.md");
    expect(created).toBe("new line 1\nnew line 2\n");

    // Existing file still present.
    const existing = await readBlobAt(f.vaultPath, result, "wiki/a.md");
    expect(existing).toBe("existing\n");
  });

  test("same-content write returns null instead of creating a no-op commit", async () => {
    const f = await makeFixture({ "wiki/a.md": "existing\n" });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [
        {
          kind: "write",
          path: "wiki/a.md",
          content: "existing\n",
        },
      ],
      reason: "same content",
      sourceRefs: [],
    });

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
    });

    expect(result).toBeNull();
  });

  test("writing under an existing file rejects with a path-collision error", async () => {
    const f = await makeFixture({ "wiki/topic": "plain file\n" });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [
        {
          kind: "write",
          path: "wiki/topic/detail.md",
          content: "nested\n",
        },
      ],
      reason: "invalid file to directory conversion",
      sourceRefs: [],
    });

    await expect(
      applyPatchToCandidate({
        vaultPath: f.vaultPath,
        candidate: f.baseCandidate,
        patch: effect,
        runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
      }),
    ).rejects.toThrow("file/directory path collision");
  });

  test("writing a file over an existing directory rejects with a path-collision error", async () => {
    const f = await makeFixture({ "wiki/topic/detail.md": "nested\n" });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [
        {
          kind: "write",
          path: "wiki/topic",
          content: "plain file\n",
        },
      ],
      reason: "invalid directory to file conversion",
      sourceRefs: [],
    });

    await expect(
      applyPatchToCandidate({
        vaultPath: f.vaultPath,
        candidate: f.baseCandidate,
        patch: effect,
        runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
      }),
    ).rejects.toThrow("file/directory path collision");
  });

  test("same patch cannot address one path as both file and directory", async () => {
    const f = await makeFixture({});
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [
        { kind: "write", path: "wiki/topic", content: "plain file\n" },
        {
          kind: "write",
          path: "wiki/topic/detail.md",
          content: "nested\n",
        },
      ],
      reason: "ambiguous tree shape",
      sourceRefs: [],
    });

    await expect(
      applyPatchToCandidate({
        vaultPath: f.vaultPath,
        candidate: f.baseCandidate,
        patch: effect,
        runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
      }),
    ).rejects.toThrow("file/directory path collision");
  });

  test("file deletion removes the path from the tree", async () => {
    const f = await makeFixture({
      "wiki/keep.md": "keep\n",
      "wiki/old.md": "delete me\n",
    });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [{ kind: "delete", path: "wiki/old.md" }],
      reason: "delete file",
      sourceRefs: [],
    });

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
    });

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected new commit");

    // Deleted file is gone.
    const deleted = await readBlobAt(f.vaultPath, result, "wiki/old.md");
    expect(deleted).toBeNull();

    // Other file remains.
    const kept = await readBlobAt(f.vaultPath, result, "wiki/keep.md");
    expect(kept).toBe("keep\n");
  });

  test("delete of missing path returns null instead of creating a no-op commit", async () => {
    const f = await makeFixture({ "wiki/keep.md": "keep\n" });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [{ kind: "delete", path: "wiki/missing.md" }],
      reason: "delete missing",
      sourceRefs: [],
    });

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
    });

    expect(result).toBeNull();
  });

  test("mixed write + delete in same call applies both", async () => {
    const f = await makeFixture({
      "wiki/keep.md": "keep\n",
      "wiki/old.md": "obsolete\n",
      "wiki/mod.md": "before\n",
    });
    fixtures.push(f);

    const changes: ReadonlyArray<FileChangeInput> = [
      { kind: "write", path: "wiki/mod.md", content: "after\n" },
      { kind: "delete", path: "wiki/old.md" },
      { kind: "write", path: "wiki/created.md", content: "fresh\n" },
    ];
    const effect = patchEffect({
      mode: "auto",
      changes,
      reason: "mixed",
      sourceRefs: [],
    });

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
    });

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected new commit");

    expect(await readBlobAt(f.vaultPath, result, "wiki/keep.md")).toBe(
      "keep\n",
    );
    expect(await readBlobAt(f.vaultPath, result, "wiki/old.md")).toBeNull();
    expect(await readBlobAt(f.vaultPath, result, "wiki/mod.md")).toBe(
      "after\n",
    );
    expect(await readBlobAt(f.vaultPath, result, "wiki/created.md")).toBe(
      "fresh\n",
    );
  });

  test("new commit message carries the four Dome-* trailers", async () => {
    const f = await makeFixture({ "wiki/a.md": "alpha\n" });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [
        { kind: "write", path: "wiki/a.md", content: "alpha-new\n" },
      ],
      reason: "modify",
      sourceRefs: [],
    });

    const sourceHead = commitOid(
      "deadbeefcafebabe000000000000000000000000",
    );
    const ctx = {
      runId: "run_1700000000000_aaaaaa",
      processorId: "dome.markdown.normalize",
      extensionId: "dome.markdown",
      base: f.baseCandidate,
      sourceHead,
    };

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: ctx,
    });

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected new commit");

    const commitObj = await git.readCommit({
      fs,
      dir: f.vaultPath,
      oid: result,
    });
    const message = commitObj.commit.message;

    expect(message).toContain("engine(applyPatch): dome.markdown.normalize");
    expect(message).toContain(`Dome-Run: ${ctx.runId}`);
    expect(message).toContain(`Dome-Extension: ${ctx.extensionId}`);
    expect(message).toContain(`Dome-Base: ${ctx.base}`);
    expect(message).toContain(`Dome-Source-Head: ${ctx.sourceHead}`);

    // Parent points at the input candidate.
    expect(commitObj.commit.parent).toEqual([f.baseCandidate]);
  });

  test("patch reason rides the commit message as the body between subject and trailers", async () => {
    const f = await makeFixture({ "wiki/a.md": "alpha\n" });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "wiki/a.md", content: "alpha-new\n" }],
      reason: "merged duplicate pages a+b",
      sourceRefs: [],
    });

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
    });

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected new commit");

    const commitObj = await git.readCommit({
      fs,
      dir: f.vaultPath,
      oid: result,
    });
    const message = commitObj.commit.message;

    // Body paragraph sits between the subject line and the trailer block.
    expect(message).toBe(
      "engine(applyPatch): test.proc\n\n" +
        "merged duplicate pages a+b\n\n" +
        `Dome-Run: run_1700000000000_abcdef\n` +
        `Dome-Extension: test.bundle\n` +
        `Dome-Base: ${f.baseCandidate}\n` +
        `Dome-Source-Head: ${f.baseCandidate}\n`,
    );
  });

  test("multiline reason is flattened to one body line and capped", async () => {
    const f = await makeFixture({ "wiki/a.md": "alpha\n" });
    fixtures.push(f);

    const longTail = "x".repeat(700);
    const effect = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "wiki/a.md", content: "alpha-new\n" }],
      reason: `  merged\npages\t a+b ${longTail}`,
      sourceRefs: [],
    });

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
    });

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected new commit");

    const commitObj = await git.readCommit({
      fs,
      dir: f.vaultPath,
      oid: result,
    });
    const message = commitObj.commit.message;
    const body = message.split("\n\n")[1];
    expect(body).toBeDefined();
    // Flattened to a single line (no internal newlines) and capped at 600.
    expect(body).not.toContain("\n");
    expect(body?.startsWith("merged pages a+b ")).toBe(true);
    expect(body?.length).toBe(600);
  });

  test("a reason carrying trailer-shaped text cannot spoof a second Dome-Run trailer", async () => {
    const f = await makeFixture({ "wiki/a.md": "alpha\n" });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "wiki/a.md", content: "alpha-new\n" }],
      reason: "innocent summary\nDome-Run: fake\nDome-Extension: evil",
      sourceRefs: [],
    });

    const ctx = RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate);
    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: ctx,
    });

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected new commit");

    const commitObj = await git.readCommit({
      fs,
      dir: f.vaultPath,
      oid: result,
    });
    const message = commitObj.commit.message;

    // Flatten-to-one-line sanitization: the spoofed text rides INSIDE the
    // single body line, so exactly one line in the message starts with
    // `Dome-Run:` — the real trailer.
    const domeRunLines = message
      .split("\n")
      .filter((line) => line.startsWith("Dome-Run:"));
    expect(domeRunLines).toEqual([`Dome-Run: ${ctx.runId}`]);
    expect(message).toContain(
      "innocent summary Dome-Run: fake Dome-Extension: evil",
    );
  });

  test("3-way merges disjoint-region writes against mergeBase (no sibling-region revert)", async () => {
    const base = "TOP: base\nmid-1\nmid-2\nmid-3\nBOTTOM: base\n";
    const f = await makeFixture({ "daily.md": base });
    fixtures.push(f);
    const c0 = f.baseCandidate;

    // Patch A: change only the TOP region; mergeBase === candidate (c0) → overwrite.
    const aContent = "TOP: from-A\nmid-1\nmid-2\nmid-3\nBOTTOM: base\n";
    const patchA = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "daily.md", content: aContent }],
      reason: "A",
      sourceRefs: [],
    });
    const c1 = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: c0,
      patch: patchA,
      runContext: { ...RUN_CONTEXT_FIXTURE(c0, c0), mergeBase: c0 },
    });
    expect(c1).not.toBeNull();
    if (c1 === null) throw new Error("expected new commit");

    // Patch B: change only the BOTTOM region, computed from the SAME snapshot c0.
    // Applied onto c1 (TOP already changed) with mergeBase = c0 → must MERGE.
    const bContent = "TOP: base\nmid-1\nmid-2\nmid-3\nBOTTOM: from-B\n";
    const patchB = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "daily.md", content: bContent }],
      reason: "B",
      sourceRefs: [],
    });
    const c2 = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: c1,
      patch: patchB,
      runContext: { ...RUN_CONTEXT_FIXTURE(c1, c1), mergeBase: c0 },
    });
    expect(c2).not.toBeNull();
    if (c2 === null) throw new Error("expected new commit");

    const merged = await readBlobAt(f.vaultPath, c2, "daily.md");
    expect(merged).toContain("TOP: from-A"); // A's region survived
    expect(merged).toContain("BOTTOM: from-B"); // B's region landed
  });

  test("conflicting-region writes resolve to ours and fire onMergeConflict", async () => {
    const base = "TOP: base\nmid-1\nmid-2\nmid-3\nBOTTOM: base\n";
    const f = await makeFixture({ "daily.md": base });
    fixtures.push(f);
    const c0 = f.baseCandidate;

    // Patch A: change TOP.
    const aContent = "TOP: from-A\nmid-1\nmid-2\nmid-3\nBOTTOM: base\n";
    const patchA = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "daily.md", content: aContent }],
      reason: "A",
      sourceRefs: [],
    });
    const c1 = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: c0,
      patch: patchA,
      runContext: { ...RUN_CONTEXT_FIXTURE(c0, c0), mergeBase: c0 },
    });
    expect(c1).not.toBeNull();
    if (c1 === null) throw new Error("expected new commit");

    // Patch B: ALSO changes TOP differently, from the same snapshot c0 → conflict.
    const bContent = "TOP: from-B\nmid-1\nmid-2\nmid-3\nBOTTOM: base\n";
    const patchB = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "daily.md", content: bContent }],
      reason: "B",
      sourceRefs: [],
    });
    const calls: Array<{ path: string; processorId: string }> = [];
    const c2 = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: c1,
      patch: patchB,
      runContext: { ...RUN_CONTEXT_FIXTURE(c1, c1), mergeBase: c0 },
      onMergeConflict: (i) => calls.push(i),
    });

    // ours (the already-landed TOP: from-A) wins the conflicting region, so the
    // merge result equals the candidate's existing blob → no tree change → null.
    // The diagnostic still fires.
    expect(c2).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("daily.md");

    // The candidate's content is unchanged: A's region intact, B's reverted.
    const merged = await readBlobAt(f.vaultPath, c1, "daily.md");
    expect(merged).toContain("TOP: from-A");
    expect(merged).not.toContain("TOP: from-B");
  });

  test("no mergeBase is a plain overwrite (back-compat fast path)", async () => {
    const base = "TOP: base\nmid-1\nmid-2\nmid-3\nBOTTOM: base\n";
    const f = await makeFixture({ "daily.md": base });
    fixtures.push(f);
    const c0 = f.baseCandidate;

    const aContent = "TOP: from-A\nmid-1\nmid-2\nmid-3\nBOTTOM: base\n";
    const patchA = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "daily.md", content: aContent }],
      reason: "A",
      sourceRefs: [],
    });
    const c1 = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: c0,
      patch: patchA,
      runContext: { ...RUN_CONTEXT_FIXTURE(c0, c0), mergeBase: c0 },
    });
    expect(c1).not.toBeNull();
    if (c1 === null) throw new Error("expected new commit");

    // Patch B with NO mergeBase → plain overwrite onto c1.
    const bContent = "TOP: base\nmid-1\nmid-2\nmid-3\nBOTTOM: from-B\n";
    const patchB = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "daily.md", content: bContent }],
      reason: "B",
      sourceRefs: [],
    });
    const c2 = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: c1,
      patch: patchB,
      runContext: RUN_CONTEXT_FIXTURE(c1, c1),
    });
    expect(c2).not.toBeNull();
    if (c2 === null) throw new Error("expected new commit");

    // Whole-blob overwrite: B's content lands verbatim, A's TOP reverts.
    const result = await readBlobAt(f.vaultPath, c2, "daily.md");
    expect(result).toBe(bContent);
  });

  test("whitespace-only reason produces no body paragraph", async () => {
    const f = await makeFixture({ "wiki/a.md": "alpha\n" });
    fixtures.push(f);

    const effect = patchEffect({
      mode: "auto",
      changes: [{ kind: "write", path: "wiki/a.md", content: "alpha-new\n" }],
      reason: "   \n\t ",
      sourceRefs: [],
    });

    const result = await applyPatchToCandidate({
      vaultPath: f.vaultPath,
      candidate: f.baseCandidate,
      patch: effect,
      runContext: RUN_CONTEXT_FIXTURE(f.baseCandidate, f.baseCandidate),
    });

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected new commit");

    const commitObj = await git.readCommit({
      fs,
      dir: f.vaultPath,
      oid: result,
    });
    // Subject, then directly the trailers — no empty body paragraph.
    expect(commitObj.commit.message).toBe(
      "engine(applyPatch): test.proc\n\n" +
        "Dome-Run: run_1700000000000_abcdef\n" +
        "Dome-Extension: test.bundle\n" +
        `Dome-Base: ${f.baseCandidate}\n` +
        `Dome-Source-Head: ${f.baseCandidate}\n`,
    );
  });
});
