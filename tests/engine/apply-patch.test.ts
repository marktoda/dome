// Phase 12a — `applyPatchToCandidate` candidate-tree mutator tests.
//
// Exercises the `src/engine/apply-patch.ts` plumbing primitive against a
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

import { applyPatchToCandidate } from "../../src/engine/apply-patch";
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
});
