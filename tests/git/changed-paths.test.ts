import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPathsForCommit, log } from "../../src/git";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await p.exited;
  if (code !== 0) {
    const err = await new Response(p.stderr).text();
    throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${err.trim()}`);
  }
}

describe("changedPathsForCommit", () => {
  test("returns files a commit changed (vs its parent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-cp-"));
    await git(dir, "init", "-q");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    await Bun.write(join(dir, "x.md"), "x");
    await git(dir, "add", "."); await git(dir, "commit", "-qm", "A");
    await Bun.write(join(dir, "y.md"), "y");
    await git(dir, "add", "."); await git(dir, "commit", "-qm", "B");
    const commits = await log({ path: dir, depth: 5 }); // newest-first
    const head = await changedPathsForCommit({ path: dir, sha: commits[0]!.oid });
    expect(head).toContain("y.md");
    expect(head).not.toContain("x.md");
  });

  test("root commit reports all its files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-cp2-"));
    await git(dir, "init", "-q");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");
    await Bun.write(join(dir, "x.md"), "x");
    await git(dir, "add", "."); await git(dir, "commit", "-qm", "root");
    const commits = await log({ path: dir, depth: 5 });
    const root = await changedPathsForCommit({ path: dir, sha: commits.at(-1)!.oid });
    expect(root).toContain("x.md");
  });

  test("nested vault: returns vault-relative paths, not repo-root-relative paths", async () => {
    // Simulate the dogfood case: git root is `dir`, vault lives at `dir/sub`.
    // A commit that touches `sub/wiki/entities/a.md` should appear as
    // `wiki/entities/a.md` (vault-relative), NOT as `sub/wiki/entities/a.md`.
    const dir = mkdtempSync(join(tmpdir(), "dome-cp3-"));
    await git(dir, "init", "-q");
    await git(dir, "config", "user.email", "t@t");
    await git(dir, "config", "user.name", "t");

    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "sub", "wiki", "entities"), { recursive: true });
    await Bun.write(join(dir, "sub", "wiki", "entities", "a.md"), "# A\n");
    await git(dir, "add", "."); await git(dir, "commit", "-qm", "add entity");

    const commits = await log({ path: join(dir, "sub"), depth: 5 });
    const sha = commits.at(-1)!.oid;
    const paths = await changedPathsForCommit({ path: join(dir, "sub"), sha });

    expect(paths).toContain("wiki/entities/a.md");
    expect(paths).not.toContain("sub/wiki/entities/a.md");
  });
});
