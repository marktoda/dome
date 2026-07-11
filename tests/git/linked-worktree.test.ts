import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  add,
  changedPathsForCommit,
  checkoutPathsAtRef,
  commitFilesOnHead,
  countCommitsOnlyIn,
  countCommitsSince,
  currentBranch,
  currentSha,
  fileInfoAtCommit,
  findGitRoot,
  isAncestor,
  isGitRepo,
  isWorkingTreeDirty,
  log,
  logWithTrailers,
  readBlob,
  readBlobByOid,
  readRef,
  readRefResult,
  readTree,
  resolveRef,
  statusMatrix,
  writeRef,
} from "../../src/git";

async function nativeGit(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

describe("git boundary in a linked worktree", () => {
  test("reads and writes the linked branch without touching the main branch or index", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "dome-linked-worktree-"));
    const main = join(fixture, "main");
    const linked = join(fixture, "linked");
    try {
      await mkdir(main);
      await nativeGit(main, "init", "-q", "-b", "main");
      await nativeGit(main, "config", "user.name", "Fixture");
      await nativeGit(main, "config", "user.email", "fixture@example.com");
      await writeFile(join(main, "README.md"), "initial\n");
      await nativeGit(main, "add", "README.md");
      await nativeGit(main, "commit", "-qm", "initial");
      const initial = await nativeGit(main, "rev-parse", "HEAD");

      await nativeGit(main, "worktree", "add", "-q", "-b", "linked", linked);
      await writeFile(join(main, "main-staged.md"), "main index only\n");
      await nativeGit(main, "add", "main-staged.md");

      expect(await findGitRoot(linked)).toBe(linked);
      expect(await isGitRepo(linked)).toBeTrue();
      expect(await currentBranch(linked)).toBe("linked");
      expect(await currentSha(linked)).toBe(initial);
      expect(await resolveRef({ path: linked })).toBe(initial);
      expect(await statusMatrix(linked)).toEqual([["README.md", 1, 1, 1]]);

      // An unrelated staged edit in the linked index must not ride along with
      // Dome's tree-only capture commit.
      await writeFile(join(linked, "linked-staged.md"), "linked index only\n");
      await add(linked, "linked-staged.md");
      const captured = "# Captured\n\nA linked-worktree thought.\n";
      await writeFile(join(linked, "inbox", "captured.md"), captured, { flag: "w" }).catch(async () => {
        await mkdir(join(linked, "inbox"), { recursive: true });
        await writeFile(join(linked, "inbox", "captured.md"), captured);
      });
      const captureCommit = await commitFilesOnHead({
        path: linked,
        files: [{ filepath: "inbox/captured.md", content: captured }],
        message: "capture: linked-worktree thought",
      });

      expect(await currentSha(linked)).toBe(captureCommit);
      expect(await readBlob({ path: linked, commit: captureCommit, filepath: "inbox/captured.md" })).toBe(captured);
      const tree = await readTree({ path: linked, oid: captureCommit });
      expect(tree.tree.map((entry) => entry.path)).toContain("inbox");
      expect((await log({ path: linked, depth: 2 })).map((entry) => entry.oid)).toEqual([
        captureCommit,
        initial,
      ]);
      expect(await statusMatrix(linked)).toContainEqual(["linked-staged.md", 0, 2, 2]);
      expect(await isWorkingTreeDirty(linked)).toBeTrue();
      expect(await changedPathsForCommit({ path: linked, sha: captureCommit })).toEqual(["inbox/captured.md"]);
      expect(await isAncestor({ path: linked, ancestor: initial, descendant: captureCommit })).toBeTrue();
      expect(await countCommitsSince({ path: linked, ancestor: initial, descendant: captureCommit })).toBe(1);
      expect(await countCommitsSince({ path: linked, ancestor: initial, descendant: captureCommit, maxDepth: 0 })).toBeNull();
      expect(await countCommitsOnlyIn({ path: linked, tip: captureCommit, exclude: initial })).toBe(1);
      expect((await logWithTrailers({ path: linked, limit: 1 }))[0]?.subject).toBe("capture: linked-worktree thought");
      expect((await fileInfoAtCommit({ path: linked, commit: captureCommit, filepath: "inbox/captured.md" }))?.lastChangedCommit).toBe(captureCommit);

      const inbox = tree.tree.find((entry) => entry.path === "inbox");
      expect(inbox?.type).toBe("tree");
      const inboxTree = await readTree({ path: linked, oid: inbox!.oid });
      const capturedBlob = inboxTree.tree.find((entry) => entry.path === "captured.md");
      expect(await readBlobByOid({ path: linked, oid: capturedBlob!.oid })).toBe(captured);

      expect(await readRefResult({ path: linked, ref: "refs/dome/test" })).toEqual({ kind: "missing" });
      await writeRef({ path: linked, ref: "refs/dome/test", value: captureCommit });
      expect(await readRef({ path: linked, ref: "refs/dome/test" })).toBe(captureCommit);

      await writeFile(join(linked, "README.md"), "changed locally\n");
      await checkoutPathsAtRef({ path: linked, ref: initial, filepaths: ["README.md"] });
      expect(await readFile(join(linked, "README.md"), "utf8")).toBe("initial\n");

      // Common objects/refs are visible from main, but its branch, worktree,
      // and index remain exactly where they were.
      expect(await currentBranch(main)).toBe("main");
      expect(await currentSha(main)).toBe(initial);
      expect(await nativeGit(main, "rev-parse", "main")).toBe(initial);
      expect(await nativeGit(main, "status", "--porcelain")).toBe("A  main-staged.md");
      expect(await nativeGit(main, "cat-file", "-t", captureCommit)).toBe("commit");
      expect(await readBlob({ path: main, commit: initial, filepath: "inbox/captured.md" })).toBeNull();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
