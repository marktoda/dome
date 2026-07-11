import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commitFilesOnHead,
  currentBranch,
  currentSha,
  readBlob,
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

describe("linked-worktree-gitdir-split gotcha", () => {
  test("a linked write advances only its branch and index", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "dome-gotcha-linked-"));
    const main = join(fixture, "main");
    const linked = join(fixture, "linked");
    try {
      await mkdir(main);
      await nativeGit(main, "init", "-q", "-b", "main");
      await nativeGit(main, "config", "user.name", "Fixture");
      await nativeGit(main, "config", "user.email", "fixture@example.com");
      await writeFile(join(main, "seed.md"), "seed\n");
      await nativeGit(main, "add", ".");
      await nativeGit(main, "commit", "-qm", "base");
      const base = await nativeGit(main, "rev-parse", "HEAD");
      await nativeGit(main, "worktree", "add", "-q", "-b", "linked", linked);

      await writeFile(join(linked, "capture.md"), "linked capture\n");
      const captured = await commitFilesOnHead({
        path: linked,
        files: [{ filepath: "capture.md", content: "linked capture\n" }],
        message: "capture in linked worktree",
      });

      expect(await currentBranch(linked)).toBe("linked");
      expect(await currentSha(linked)).toBe(captured);
      expect(await readBlob({ path: linked, commit: captured, filepath: "capture.md" })).toBe("linked capture\n");
      expect(await currentBranch(main)).toBe("main");
      expect(await currentSha(main)).toBe(base);
      expect(await nativeGit(main, "status", "--porcelain")).toBe("");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
