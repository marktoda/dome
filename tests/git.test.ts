import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  commit,
  commitFilesOnHead,
  commitInitialFiles,
  commitSingleFileOnHead,
  countCommitsSince,
  fileInfoAtCommit,
  initRepo,
  isAncestor,
  isWorkingTreeDirty,
  log,
  readBlob,
  recoverIndexAfterExactCommit,
  replayBranchRefDurability,
  readTree,
  resolveRef,
  statusMatrix,
  writeRef,
} from "../src/git";

describe("git boundary", () => {
  test("fileInfoAtCommit returns the commit that last changed a file", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-info-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "one\n");
      const first = await commit({
        path,
        message: "first",
        files: ["wiki/a.md"],
        committer: identityAt("2026-05-01T12:00:00.000Z"),
      });

      await write(path, "wiki/b.md", "unrelated\n");
      await commit({
        path,
        message: "second",
        files: ["wiki/b.md"],
        committer: identityAt("2026-05-02T12:00:00.000Z"),
      });

      await write(path, "wiki/a.md", "two\n");
      const third = await commit({
        path,
        message: "third",
        files: ["wiki/a.md"],
        committer: identityAt("2026-05-03T12:00:00.000Z"),
      });

      const firstInfo = await fileInfoAtCommit({
        path,
        commit: first,
        filepath: "wiki/a.md",
      });
      expect(firstInfo).toEqual({
        lastChangedCommit: first,
        lastChangedAt: "2026-05-01T12:00:00.000Z",
        lastHumanChangedCommit: first,
        lastHumanChangedAt: "2026-05-01T12:00:00.000Z",
      });

      const latestInfo = await fileInfoAtCommit({
        path,
        commit: third,
        filepath: "wiki/a.md",
      });
      expect(latestInfo).toEqual({
        lastChangedCommit: third,
        lastChangedAt: "2026-05-03T12:00:00.000Z",
        lastHumanChangedCommit: third,
        lastHumanChangedAt: "2026-05-03T12:00:00.000Z",
      });
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("fileInfoAtCommit ignores Dome-authored commits for lastHumanChanged*", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-human-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "one\n");
      const human = await commit({
        path,
        message: "human edit",
        files: ["wiki/a.md"],
        committer: identityAt("2026-05-01T12:00:00.000Z"),
      });

      // An engine "closure commit" carrying a Dome-Run trailer (per
      // src/engine-commit.ts). This rewrites the same file but must NOT
      // count as the human-authored last-changed signal.
      await write(path, "wiki/a.md", "one ^block-anchor\n");
      const dome = await commit({
        path,
        message:
          "garden: stamp block anchors\n\n" +
          "Dome-Run: run-abc\n" +
          "Dome-Extension: dome.task.stamp-block-id\n" +
          "Dome-Base: base-oid\n" +
          "Dome-Source-Head: head-oid",
        files: ["wiki/a.md"],
        committer: identityAt("2026-05-02T12:00:00.000Z"),
      });

      const info = await fileInfoAtCommit({
        path,
        commit: dome,
        filepath: "wiki/a.md",
      });
      expect(info).toEqual({
        lastChangedCommit: dome,
        lastChangedAt: "2026-05-02T12:00:00.000Z",
        lastHumanChangedCommit: human,
        lastHumanChangedAt: "2026-05-01T12:00:00.000Z",
      });
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("fileInfoAtCommit reports null lastHumanChanged* when every commit is Dome-authored", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-all-dome-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "one ^anchor\n");
      const dome = await commit({
        path,
        message:
          "garden: stamp block anchors\n\n" +
          "Dome-Run: run-xyz\n" +
          "Dome-Extension: dome.task.stamp-block-id\n" +
          "Dome-Base: base-oid\n" +
          "Dome-Source-Head: head-oid",
        files: ["wiki/a.md"],
        committer: identityAt("2026-05-01T12:00:00.000Z"),
      });

      const info = await fileInfoAtCommit({
        path,
        commit: dome,
        filepath: "wiki/a.md",
      });
      expect(info).toEqual({
        lastChangedCommit: dome,
        lastChangedAt: "2026-05-01T12:00:00.000Z",
        lastHumanChangedCommit: null,
        lastHumanChangedAt: null,
      });
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("countCommitsSince counts descendant commits and returns null off ancestry", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-count-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "one\n");
      const first = await commit({
        path,
        message: "first",
        files: ["wiki/a.md"],
      });
      await write(path, "wiki/b.md", "two\n");
      const second = await commit({
        path,
        message: "second",
        files: ["wiki/b.md"],
      });
      await write(path, "wiki/c.md", "three\n");
      const third = await commit({
        path,
        message: "third",
        files: ["wiki/c.md"],
      });

      expect(
        await countCommitsSince({
          path,
          ancestor: first,
          descendant: third,
        }),
      ).toBe(2);
      expect(
        await countCommitsSince({
          path,
          ancestor: third,
          descendant: third,
        }),
      ).toBe(0);
      expect(
        await countCommitsSince({
          path,
          ancestor: first,
          descendant: third,
          maxDepth: 1,
        }),
      ).toBeNull();
      expect(
        await countCommitsSince({
          path,
          ancestor: second,
          descendant: first,
        }),
      ).toBeNull();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("readTree scopes commit OIDs to a nested vault prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-git-nested-tree-"));
    const vaultPath = join(root, "docs");
    try {
      await initRepo(root);
      await write(root, "README.md", "outer\n");
      await write(root, "docs/wiki/a.md", "inner\n");
      const sha = await commit({
        path: root,
        message: "nested vault",
        files: ["README.md", "docs/wiki/a.md"],
      });

      const vaultTree = await readTree({ path: vaultPath, oid: sha });
      expect(vaultTree.tree.map((entry) => entry.path)).toEqual(["wiki"]);

      const wiki = vaultTree.tree.find((entry) => entry.path === "wiki");
      expect(wiki?.type).toBe("tree");
      if (wiki === undefined) throw new Error("expected wiki tree");

      const wikiTree = await readTree({ path: vaultPath, oid: wiki.oid });
      expect(wikiTree.tree.map((entry) => entry.path)).toEqual(["a.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("statusMatrix excludes transient Dome state but keeps vault config visible", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-status-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "one\n");
      await commit({
        path,
        message: "first",
        files: ["wiki/a.md"],
      });

      await write(path, ".dome/state/locks/main.compiler-host.lock", "lock\n");
      await write(path, ".dome/config.yaml", "extensions: {}\n");

      const paths = (await statusMatrix(path)).map(([filepath]) => filepath);
      expect(paths).toContain(".dome/config.yaml");
      expect(paths).not.toContain(".dome/state/locks/main.compiler-host.lock");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  // Pins the daemon-race contract on commitSingleFileOnHead: the branch ref
  // advance is compare-and-swap, so a concurrent advance of
  // refs/heads/<branch> (the serve host adopting between the HEAD read and
  // the ref write) triggers a rebuild-and-retry on the new head instead of
  // force-moving the branch backwards past the engine's closure commit.
  test("commitSingleFileOnHead retries onto a concurrently-advanced branch head", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-single-race-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "base\n");
      await commit({ path, message: "base", files: ["wiki/a.md"] });

      // The concurrent writer: between the capture's commit-object write and
      // its ref advance, land an unrelated commit on the branch (what the
      // engine's Phase 12c branch advance does during adoption).
      let concurrent: string | null = null;
      await write(path, "inbox/raw/x.md", "the capture\n");
      const captureOid = await commitSingleFileOnHead({
        path,
        filepath: "inbox/raw/x.md",
        content: "the capture\n",
        message: "capture: x",
        beforeRefAdvance: async (attempt) => {
          if (attempt === 1) {
            await write(path, "wiki/b.md", "engine work\n");
            concurrent = await commit({
              path,
              message: "engine: concurrent advance",
              files: ["wiki/b.md"],
            });
          }
        },
      });
      if (concurrent === null) throw new Error("expected a concurrent commit");

      // The branch landed on the capture commit, whose parent is the
      // concurrent commit — nothing was force-moved backwards or lost.
      expect(await resolveRef({ path, ref: "refs/heads/main" })).toBe(captureOid);
      const entries = await log({ path, depth: 3 });
      expect(entries[0]?.oid).toBe(captureOid);
      expect(entries[0]?.commit.parent).toEqual([concurrent]);
      expect(
        await isAncestor({ path, ancestor: concurrent, descendant: captureOid }),
      ).toBe(true);
      // Both the concurrent commit's file and the capture survive in the tree.
      expect(
        await readBlob({ path, commit: captureOid, filepath: "wiki/b.md" }),
      ).toBe("engine work\n");
      expect(
        await readBlob({ path, commit: captureOid, filepath: "inbox/raw/x.md" }),
      ).toBe("the capture\n");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("commitFilesOnHead atomically rejects a same-OID symbolic HEAD switch", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-head-switch-"));
    try {
      await initRepo(path);
      await write(path, "base.md", "base\n");
      const base = await commit({ path, message: "base", files: ["base.md"] });
      await expect(commitFilesOnHead({
        path,
        files: [{ filepath: "Dome.md", content: "dome\n" }],
        message: "candidate",
        expectedHead: base,
        expectedBranch: "main",
        beforeRefAdvance: async () => {
          const switched = Bun.spawn(["git", "-C", path, "switch", "-c", "raced"], { stderr: "pipe" });
          expect(await switched.exited).toBe(0);
        },
      })).rejects.toThrow(/symbolic HEAD changed/);
      expect(await resolveRef({ path, ref: "refs/heads/main" })).toBe(base);
      expect(await resolveRef({ path, ref: "refs/heads/raced" })).toBe(base);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("commitFilesOnHead never retries an exact expected parent", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-exact-parent-"));
    try {
      await initRepo(path);
      await write(path, "base.md", "base\n");
      const base = await commit({ path, message: "base", files: ["base.md"] });
      let attempts = 0;
      let concurrent = "";
      await expect(commitFilesOnHead({
        path,
        files: [{ filepath: "Dome.md", content: "dome\n" }],
        message: "candidate",
        expectedHead: base,
        beforeRefAdvance: async () => {
          attempts += 1;
          await write(path, "owner.md", "owner\n");
          concurrent = await commit({ path, message: "owner", files: ["owner.md"] });
        },
      })).rejects.toThrow(/expected/);
      expect(attempts).toBe(1);
      expect(await resolveRef({ path, ref: "refs/heads/main" })).toBe(concurrent);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("commitFilesOnHead preserves owner staging raced before its index lock", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-index-race-"));
    try {
      await initRepo(path);
      await write(path, "Dome.md", "base\n");
      const base = await commit({ path, message: "base", files: ["Dome.md"] });
      await write(path, "Dome.md", "owner staged\n");
      await expect(commitFilesOnHead({
        path,
        files: [{ filepath: "Dome.md", content: "dome candidate\n" }],
        message: "candidate",
        expectedHead: base,
        beforeRefAdvance: async () => {
          const add = Bun.spawn(["git", "-C", path, "add", "--", "Dome.md"], { stderr: "pipe" });
          expect(await add.exited).toBe(0);
        },
      })).rejects.toThrow("index changed before exact transition");
      expect(await resolveRef({ path, ref: "refs/heads/main" })).toBe(base);
      const staged = Bun.spawn(["git", "-C", path, "show", ":Dome.md"], { stdout: "pipe" });
      expect(await new Response(staged.stdout).text()).toBe("owner staged\n");
      expect(await staged.exited).toBe(0);
    } finally { await rm(path, { recursive: true, force: true }); }
  });

  test("an existing owner index lock blocks Dome before branch mutation", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-index-lock-"));
    try {
      await initRepo(path);
      await write(path, "base.md", "base\n");
      const base = await commit({ path, message: "base", files: ["base.md"] });
      const ownerLock = join(path, ".git/index.lock");
      await writeFile(ownerLock, "owner lock\n");
      await expect(commitFilesOnHead({
        path,
        files: [{ filepath: "Dome.md", content: "dome\n" }],
        message: "candidate",
        expectedHead: base,
      })).rejects.toThrow("could not lock index");
      expect(await resolveRef({ path, ref: "refs/heads/main" })).toBe(base);
      expect(await readFile(ownerLock, "utf8")).toBe("owner lock\n");
      await unlink(ownerLock);
    } finally { await rm(path, { recursive: true, force: true }); }
  });

  test("replays ref-parent durability after the branch rename is visible", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-ref-durability-"));
    try {
      await initRepo(path);
      await write(path, "base.md", "base\n");
      const base = await commit({ path, message: "base", files: ["base.md"] });
      let faults = 0;
      const candidate = await commitFilesOnHead({
        path,
        files: [{ filepath: "Dome.md", content: "dome\n" }],
        message: "candidate",
        expectedHead: base,
        beforeRefParentSync: async () => { faults += 1; throw new Error("injected ref parent fault"); },
      });
      expect(faults).toBe(1);
      expect(await resolveRef({ path, ref: "refs/heads/main" })).toBe(candidate);
    } finally { await rm(path, { recursive: true, force: true }); }
  });

  test("replays exact branch durability when Git has packed the ref", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-packed-ref-"));
    try {
      await initRepo(path);
      await write(path, "base.md", "base\n");
      const head = await commit({ path, message: "base", files: ["base.md"] });
      const packed = Bun.spawn(["git", "-C", path, "pack-refs", "--all", "--prune"], { stderr: "pipe" });
      expect(await packed.exited).toBe(0);
      expect(await Bun.file(join(path, ".git/refs/heads/main")).exists()).toBeFalse();
      await replayBranchRefDurability({ path, branch: "main", value: head });
      expect(await resolveRef({ path, ref: "refs/heads/main" })).toBe(head);
    } finally { await rm(path, { recursive: true, force: true }); }
  });

  test("recovery preserves owner staging and replays a published index rename", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-index-recovery-"));
    try {
      await initRepo(path);
      await write(path, "Dome.md", "base\n");
      const base = await commit({ path, message: "base", files: ["Dome.md"] });
      let candidate = "";
      await expect(commitFilesOnHead({
        path,
        files: [{ filepath: "Dome.md", content: "dome committed\n" }],
        message: "candidate",
        expectedHead: base,
        onCandidate: async (row) => { candidate = row.commit; },
        beforeIndexParentSync: async () => { throw new Error("injected after index rename"); },
      })).rejects.toThrow("injected after index rename");
      expect(await resolveRef({ path, ref: "refs/heads/main" })).toBe(candidate);
      await recoverIndexAfterExactCommit({ path, commit: candidate, parent: base, files: ["Dome.md"] });

      await write(path, "Dome.md", "owner staged\n");
      const add = Bun.spawn(["git", "-C", path, "add", "--", "Dome.md"], { stderr: "pipe" });
      expect(await add.exited).toBe(0);
      await expect(recoverIndexAfterExactCommit({
        path, commit: candidate, parent: base, files: ["Dome.md"],
      })).rejects.toThrow("conflicting staged owner state");
      const staged = Bun.spawn(["git", "-C", path, "show", ":Dome.md"], { stdout: "pipe" });
      expect(await new Response(staged.stdout).text()).toBe("owner staged\n");
      expect(await staged.exited).toBe(0);
    } finally { await rm(path, { recursive: true, force: true }); }
  });

  test("commitInitialFiles rejects an unborn symbolic HEAD switch", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-initial-switch-"));
    try {
      await initRepo(path);
      await expect(commitInitialFiles({
        path,
        files: [{ filepath: "Dome.md", content: Buffer.from("dome\n"), mode: "100644" }],
        message: "initial",
        expectedBranch: "main",
        beforeRefAdvance: async () => {
          const renamed = Bun.spawn(["git", "-C", path, "branch", "-m", "raced"], { stderr: "pipe" });
          expect(await renamed.exited).toBe(0);
        },
      })).rejects.toThrow(/symbolic HEAD changed/);
      expect(await Bun.file(join(path, ".git/HEAD")).text()).toBe("ref: refs/heads/raced\n");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("commitSingleFileOnHead gives up with a clear error when the branch keeps moving", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-single-race-loop-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "base\n");
      await commit({ path, message: "base", files: ["wiki/a.md"] });

      let advances = 0;
      await write(path, "inbox/raw/x.md", "the capture\n");
      await expect(
        commitSingleFileOnHead({
          path,
          filepath: "inbox/raw/x.md",
          content: "the capture\n",
          message: "capture: x",
          beforeRefAdvance: async () => {
            advances += 1;
            await write(path, `wiki/c${advances}.md`, "more\n");
            await commit({
              path,
              message: `concurrent ${advances}`,
              files: [`wiki/c${advances}.md`],
            });
          },
        }),
      ).rejects.toThrow(/kept advancing concurrently.*5 attempts/);
      expect(advances).toBe(5);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  // Task 3 (stock-gardening phase 1): commitFilesOnHead's `files` entries
  // widen to `{ filepath, content: string | null }` — `null` removes the
  // path from the tree. This is the tree-removal counterpart the janitor's
  // archive-move (write to attic/ + delete original) needs.
  test("commitFilesOnHead removes a file from the HEAD tree; the working tree copy is untouched", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-delete-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "keep\n");
      await write(path, "wiki/b.md", "remove me\n");
      const base = await commit({
        path,
        message: "base",
        files: ["wiki/a.md", "wiki/b.md"],
      });

      const oid = await commitFilesOnHead({
        path,
        files: [{ filepath: "wiki/b.md", content: null }],
        message: "delete b",
      });

      expect(await readBlob({ path, commit: oid, filepath: "wiki/b.md" })).toBeNull();
      expect(await readBlob({ path, commit: oid, filepath: "wiki/a.md" })).toBe("keep\n");
      expect(
        await isAncestor({ path, ancestor: base, descendant: oid }),
      ).toBe(true);

      // Tree-only: the helper never touches the working tree, so the file
      // the caller wrote to disk is still there (unlike the working-tree
      // unlink, which is the surface caller's job — Task 4, not this one).
      expect(existsSync(join(path, "wiki/b.md"))).toBe(true);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("commitFilesOnHead deletes one file and writes another in a single commit", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-delete-write-"));
    try {
      await initRepo(path);
      await write(path, "wiki/old.md", "stale\n");
      await commit({ path, message: "base", files: ["wiki/old.md"] });

      await write(path, "wiki/new.md", "fresh\n");
      const oid = await commitFilesOnHead({
        path,
        files: [
          { filepath: "wiki/old.md", content: null },
          { filepath: "wiki/new.md", content: "fresh\n" },
        ],
        message: "swap old for new",
      });

      expect(await readBlob({ path, commit: oid, filepath: "wiki/old.md" })).toBeNull();
      expect(await readBlob({ path, commit: oid, filepath: "wiki/new.md" })).toBe("fresh\n");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("commitFilesOnHead deleting an absent path is a no-op entry; the rest of the commit still lands", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-delete-absent-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "one\n");
      await commit({ path, message: "base", files: ["wiki/a.md"] });

      const oid = await commitFilesOnHead({
        path,
        files: [
          { filepath: "wiki/never-existed.md", content: null },
          { filepath: "wiki/a.md", content: "two\n" },
        ],
        message: "no-op delete + real write",
      });

      expect(
        await readBlob({ path, commit: oid, filepath: "wiki/never-existed.md" }),
      ).toBeNull();
      expect(await readBlob({ path, commit: oid, filepath: "wiki/a.md" })).toBe("two\n");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("commitFilesOnHead: deleting the only file in a subdirectory leaves no empty tree entry", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-delete-empty-subtree-"));
    try {
      await initRepo(path);
      await write(path, "wiki/sub/only.md", "lonely\n");
      await write(path, "wiki/other.md", "sibling\n");
      await commit({
        path,
        message: "base",
        files: ["wiki/sub/only.md", "wiki/other.md"],
      });

      const oid = await commitFilesOnHead({
        path,
        files: [{ filepath: "wiki/sub/only.md", content: null }],
        message: "delete the only file in wiki/sub",
      });

      const rootTree = await readTree({ path, oid });
      expect(rootTree.tree.map((entry) => entry.path)).toEqual(["wiki"]);
      const wikiEntry = rootTree.tree.find((entry) => entry.path === "wiki");
      if (wikiEntry === undefined) throw new Error("expected wiki entry");
      const wikiTree = await readTree({ path, oid: wikiEntry.oid });
      // `sub` is gone entirely — no empty tree object left behind.
      expect(wikiTree.tree.map((entry) => entry.path)).toEqual(["other.md"]);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("commitFilesOnHead: deleting the only leaf collapses empty subtrees all the way to the root", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-delete-cascade-"));
    try {
      await initRepo(path);
      // a/b/c.md with NO siblings at any level — deleting c.md must drop b
      // from a AND a from the root (cascading empty-subtree collapse).
      await write(path, "a/b/c.md", "deep and lonely\n");
      await commit({ path, message: "base", files: ["a/b/c.md"] });

      const oid = await commitFilesOnHead({
        path,
        files: [{ filepath: "a/b/c.md", content: null }],
        message: "delete the only leaf",
      });

      const rootTree = await readTree({ path, oid });
      // No `a` entry survives — the collapse cascaded past b up to the root.
      expect(rootTree.tree.map((entry) => entry.path)).toEqual([]);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("commitFilesOnHead: same-path delete+write in one call — last entry wins in both orders", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-delete-order-"));
    try {
      await initRepo(path);
      await write(path, "wiki/s.md", "before\n");
      await commit({ path, message: "base", files: ["wiki/s.md"] });

      // delete-then-write: the later write wins — the file exists with the
      // written content.
      await write(path, "wiki/s.md", "after\n");
      const first = await commitFilesOnHead({
        path,
        files: [
          { filepath: "wiki/s.md", content: null },
          { filepath: "wiki/s.md", content: "after\n" },
        ],
        message: "delete then write",
      });
      expect(await readBlob({ path, commit: first, filepath: "wiki/s.md" })).toBe(
        "after\n",
      );

      // write-then-delete: the later delete wins — the file is absent.
      const second = await commitFilesOnHead({
        path,
        files: [
          { filepath: "wiki/s.md", content: "phantom\n" },
          { filepath: "wiki/s.md", content: null },
        ],
        message: "write then delete",
      });
      expect(
        await readBlob({ path, commit: second, filepath: "wiki/s.md" }),
      ).toBeNull();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  // Mirror of the commitSingleFileOnHead concurrent-advance test for the
  // delete path: the concurrent head advance itself deletes the same path,
  // so the CAS-retry rebuild must treat the delete as a no-op (path already
  // absent from the new head's tree) and still land the commit.
  test("commitFilesOnHead delete retries onto a concurrent head that already deleted the path", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-delete-race-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "keep\n");
      await write(path, "wiki/x.md", "doomed\n");
      await commit({ path, message: "base", files: ["wiki/a.md", "wiki/x.md"] });

      let concurrent: string | null = null;
      const oid = await commitFilesOnHead({
        path,
        files: [{ filepath: "wiki/x.md", content: null }],
        message: "delete x",
        beforeRefAdvance: async (attempt) => {
          if (attempt === 1) {
            // The concurrent writer deletes the very same path before this
            // helper's ref advance (commit()'s files list stages removals
            // for unlinked paths).
            await rm(join(path, "wiki/x.md"), { force: true });
            concurrent = await commit({
              path,
              message: "concurrent: also deletes x",
              files: ["wiki/x.md"],
            });
          }
        },
      });
      if (concurrent === null) throw new Error("expected a concurrent commit");

      // The branch landed on our commit, whose parent is the concurrent
      // commit — the retry rebuilt on the new head, where the delete was a
      // no-op, and still landed.
      expect(await resolveRef({ path, ref: "refs/heads/main" })).toBe(oid);
      const entries = await log({ path, depth: 2 });
      expect(entries[0]?.oid).toBe(oid);
      expect(entries[0]?.commit.parent).toEqual([concurrent]);
      expect(await readBlob({ path, commit: oid, filepath: "wiki/x.md" })).toBeNull();
      expect(await readBlob({ path, commit: oid, filepath: "wiki/a.md" })).toBe("keep\n");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("statusMatrix excludes nested vault Dome state", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-git-nested-status-"));
    const vaultPath = join(root, "docs");
    try {
      await initRepo(root);
      await write(root, "docs/wiki/a.md", "inner\n");
      await commit({
        path: root,
        message: "nested vault",
        files: ["docs/wiki/a.md"],
      });

      await write(
        root,
        "docs/.dome/state/locks/main.compiler-host.lock",
        "lock\n",
      );
      await write(root, "docs/.dome/config.yaml", "extensions: {}\n");

      const paths = (await statusMatrix(vaultPath)).map(([filepath]) => filepath);
      expect(paths).toContain(".dome/config.yaml");
      expect(paths).not.toContain(".dome/state/locks/main.compiler-host.lock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isWorkingTreeDirty: false on a clean tree, true with uncommitted edits", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-dirty-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "one\n");
      await commit({
        path,
        message: "first",
        files: ["wiki/a.md"],
        committer: identityAt("2026-06-26T12:00:00.000Z"),
      });

      // Just committed — nothing uncommitted.
      expect(await isWorkingTreeDirty(path)).toBe(false);

      // A modified tracked file makes the tree dirty. (Different byte length
      // than the committed content so the change is detected regardless of the
      // git index stat-cache, which can short-circuit a same-size,
      // same-mtime-second rewrite.)
      await write(path, "wiki/a.md", "substantially different content\n");
      expect(await isWorkingTreeDirty(path)).toBe(true);

      // Committing the change returns the tree to clean.
      await commit({
        path,
        message: "second",
        files: ["wiki/a.md"],
        committer: identityAt("2026-06-26T12:01:00.000Z"),
      });
      expect(await isWorkingTreeDirty(path)).toBe(false);

      // A new untracked file also counts as dirty.
      await write(path, "wiki/draft.md", "scratch\n");
      expect(await isWorkingTreeDirty(path)).toBe(true);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("isWorkingTreeDirty: gitignored untracked files do not count as dirty", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-dirty-ignored-"));
    try {
      await initRepo(path);
      await write(path, ".gitignore", ".dome/state/\nscratch/\n");
      await write(path, "wiki/a.md", "one\n");
      await commit({
        path,
        message: "first",
        files: [".gitignore", "wiki/a.md"],
        committer: identityAt("2026-06-26T12:00:00.000Z"),
      });
      expect(await isWorkingTreeDirty(path)).toBe(false);

      // Derived/ignored files (Dome state, ignored scratch) must not freeze the
      // garden phase under the dirty-defer gate.
      await write(path, "scratch/notes.md", "ephemeral\n");
      await write(path, ".dome/state/projection.db", "binary\n");
      expect(await isWorkingTreeDirty(path)).toBe(false);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  // Live-vault evidence: 14 days of serve logs show 2 hard "Failed to advance
  // refs/heads/main ... cannot lock ref" adoption failures caused by a
  // concurrent Dome host (or a foreground git operation) holding the ref's
  // `.lock` file at the moment `writeRef`'s CAS ran. That is a transient
  // filesystem lock, not a real conflict — it should be retried, not
  // surfaced as a hard failure. These three tests exercise the retry
  // directly against a real stray `.lock` file (the exact shape `git
  // update-ref` produces), with an injected `sleep` so no test waits in
  // real time.
  test("writeRef retries a CAS update through transient ref-lock contention and succeeds once the lock clears", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-ref-lock-retry-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "one\n");
      const base = await commit({ path, message: "base", files: ["wiki/a.md"] });

      const lockPath = join(path, ".git/refs/heads/main.lock");
      await write(path, ".git/refs/heads/main.lock", "stray lock\n");

      const delays: number[] = [];
      const fakeSleep = async (ms: number): Promise<void> => {
        delays.push(ms);
        if (delays.length === 2) {
          // Simulate the concurrent host releasing the ref on the 2nd retry.
          await rm(lockPath, { force: true });
        }
      };

      await writeRef({
        path,
        ref: "refs/heads/main",
        value: base,
        expectedOld: base,
        sleep: fakeSleep,
      });

      expect(await resolveRef({ path, ref: "refs/heads/main" })).toBe(base);
      // Two failed attempts (lock still present) before the third succeeds.
      expect(delays).toHaveLength(2);
      expect(delays[0]).toBeGreaterThanOrEqual(100);
      expect(delays[1]).toBeGreaterThan(delays[0] as number);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("writeRef throws immediately (zero retries) on a non-lock ref-update error", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-ref-cas-mismatch-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "one\n");
      const base = await commit({ path, message: "base", files: ["wiki/a.md"] });
      await write(path, "wiki/b.md", "two\n");
      const second = await commit({ path, message: "second", files: ["wiki/b.md"] });
      // The branch already advanced to `second`; claiming `base` as the
      // expected old value is a real compare-and-swap conflict, not a lock.
      // git's message for this shape is "cannot lock ref '<ref>': is at
      // <X> but expected <Y>" — it contains the phrase "cannot lock ref"
      // too, so the classifier must not key off that alone.

      const delays: number[] = [];
      const fakeSleep = async (ms: number): Promise<void> => {
        delays.push(ms);
      };

      await expect(
        writeRef({
          path,
          ref: "refs/heads/main",
          value: second,
          expectedOld: base,
          sleep: fakeSleep,
        }),
      ).rejects.toThrow(/is at .* but expected/i);
      expect(delays).toHaveLength(0);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  test("writeRef exhausts retries and surfaces the original lock error with a bounded, jittered backoff", async () => {
    const path = mkdtempSync(join(tmpdir(), "dome-git-ref-lock-exhaust-"));
    try {
      await initRepo(path);
      await write(path, "wiki/a.md", "one\n");
      const base = await commit({ path, message: "base", files: ["wiki/a.md"] });

      // The lock never clears — every attempt fails.
      await write(path, ".git/refs/heads/main.lock", "stray lock\n");

      const delays: number[] = [];
      const fakeSleep = async (ms: number): Promise<void> => {
        delays.push(ms);
      };

      await expect(
        writeRef({
          path,
          ref: "refs/heads/main",
          value: base,
          expectedOld: base,
          sleep: fakeSleep,
        }),
        // The surfaced error is the ORIGINAL git error, not a generic
        // retry-exhausted wrapper.
      ).rejects.toThrow(/Unable to create '.*\.lock'.*File exists/is);

      // 5 retries between 6 total attempts.
      expect(delays).toHaveLength(5);
      // First delay >= the 100ms base.
      expect(delays[0]).toBeGreaterThanOrEqual(100);
      // Monotonically increasing (each attempt's jittered delay stays below
      // the next attempt's un-jittered base, since jitter is a fraction of
      // the base rather than a full doubling).
      for (let i = 1; i < delays.length; i += 1) {
        expect(delays[i]).toBeGreaterThan(delays[i - 1] as number);
      }
      // Bounded: the curve's endpoints are 100ms and 1.6s: attempt n's
      // un-jittered base is 100 * 2^(n-1), with jitter adding at most 25%
      // on top.
      const expectedBases = [100, 200, 400, 800, 1600];
      delays.forEach((delay, i) => {
        const base = expectedBases[i] as number;
        expect(delay).toBeGreaterThanOrEqual(base);
        expect(delay).toBeLessThanOrEqual(base * 1.25);
      });
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
});

async function write(root: string, path: string, content: string): Promise<void> {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

function identityAt(iso: string): {
  readonly name: string;
  readonly email: string;
  readonly timestamp: number;
} {
  return {
    name: "Dome Test",
    email: "test@local",
    timestamp: Date.parse(iso) / 1000,
  };
}
