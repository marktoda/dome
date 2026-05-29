import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  commit,
  countCommitsSince,
  fileInfoAtCommit,
  initRepo,
  readTree,
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
      });

      const latestInfo = await fileInfoAtCommit({
        path,
        commit: third,
        filepath: "wiki/a.md",
      });
      expect(latestInfo).toEqual({
        lastChangedCommit: third,
        lastChangedAt: "2026-05-03T12:00:00.000Z",
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
