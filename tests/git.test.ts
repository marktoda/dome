import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { commit, fileInfoAtCommit, initRepo } from "../src/git";

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
