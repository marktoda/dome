import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  commit,
  commitSingleFileOnHead,
  countCommitsSince,
  fileInfoAtCommit,
  initRepo,
  isAncestor,
  isWorkingTreeDirty,
  log,
  readBlob,
  readTree,
  resolveRef,
  statusMatrix,
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
