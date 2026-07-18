import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  add,
  changedPathsForCommit,
  checkoutPathsAtRef,
  commit,
  commitFilesOnHead,
  countCommitsOnlyIn,
  countCommitsSince,
  currentBranch,
  currentSha,
  fileInfoAtCommit,
  findGitRoot,
  initRepo,
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
import { adopt } from "../../src/engine/core/adopt";
import { noopSinks } from "../../src/engine/core/apply-effect";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import { performCapture } from "../../src/surface/capture";
import { applyControlledMutation } from "../../src/mutation/controlled-mutation";
import { openTestLedger } from "../support/test-ledger";

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

async function nativeGitInput(cwd: string, input: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input);
  proc.stdin.end();
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
      await mkdir(join(main, "docs[1]"));
      await mkdir(join(main, "docs1"));
      await writeFile(join(main, "docs[1]", "inside.md"), "inside\n");
      await writeFile(join(main, "docs1", "sibling.md"), "sibling\n");
      await writeFile(join(main, "target.md"), "target\n");
      await symlink("target.md", join(main, "link.md"));
      await nativeGit(main, "add", ".");
      await nativeGit(main, "commit", "-qm", "initial");
      const initial = await nativeGit(main, "rev-parse", "HEAD");

      await nativeGit(main, "worktree", "add", "-q", "-b", "linked", linked);
      // Exercise Git's supported relative gitdir form, not only the absolute
      // path emitted by `git worktree add` on this platform.
      const gitfile = await readFile(join(linked, ".git"), "utf8");
      const gitdir = /^gitdir:\s*(.+)\s*$/m.exec(gitfile)?.[1];
      expect(gitdir).toBeDefined();
      await writeFile(join(linked, ".git"), `gitdir: ${relative(await realpath(linked), gitdir!)}\n`);
      await writeFile(join(main, "main-staged.md"), "main index only\n");
      await nativeGit(main, "add", "main-staged.md");
      const mainIndexBefore = await readFile(join(main, ".git", "index"));

      expect(await findGitRoot(linked)).toBe(linked);
      expect(await isGitRepo(linked)).toBeTrue();
      const poisonedKeys = [
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      ] as const;
      const previousEnv = new Map(poisonedKeys.map((key) => [key, process.env[key]]));
      try {
        for (const key of poisonedKeys) process.env[key] = join(fixture, `poison-${key}`);
        expect(await resolveRef({ path: linked })).toBe(initial);
      } finally {
        for (const key of poisonedKeys) {
          const value = previousEnv.get(key);
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(await currentBranch(linked)).toBe("linked");
      expect(await currentSha(linked)).toBe(initial);
      expect(await resolveRef({ path: linked })).toBe(initial);
      expect(await statusMatrix(linked)).toContainEqual(["README.md", 1, 1, 1]);
      expect(await statusMatrix(linked)).toContainEqual(["link.md", 1, 1, 1]);
      expect(await statusMatrix(join(linked, "docs[1]"))).toEqual([["inside.md", 1, 1, 1]]);
      await expect(add(join(linked, "docs[1]"), "../docs1/escape.md")).rejects.toThrow("vault-relative");

      await rm(join(linked, "link.md"));
      await symlink("README.md", join(linked, "link.md"));
      expect(await statusMatrix(linked)).toContainEqual(["link.md", 1, 2, 1]);
      await checkoutPathsAtRef({ path: linked, ref: initial, filepaths: ["link.md"], force: true });
      expect(await statusMatrix(linked)).toContainEqual(["link.md", 1, 1, 1]);

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
      const defaultHeadLog = await logWithTrailers({ path: join(linked, "inbox"), limit: 1 });
      expect(defaultHeadLog[0]?.subject).toBe("capture: linked-worktree thought");
      // A caller-controlled ref must remain a revision token. Without the
      // end-of-options boundary this value would silently expand to every ref.
      expect(await logWithTrailers({ path: join(linked, "inbox"), ref: "--all" })).toEqual([]);
      expect((await fileInfoAtCommit({ path: linked, commit: captureCommit, filepath: "inbox/captured.md" }))?.lastChangedCommit).toBe(captureCommit);

      const controlled = await applyControlledMutation({
        vaultPath: linked,
        branch: "linked",
        requestId: "linked:capture",
        files: [{
          path: "inbox/controlled.md",
          expectedContent: null,
          content: "controlled\n",
        }],
        message: "capture: controlled linked-worktree thought",
      });
      expect(controlled.kind).toBe("committed");
      expect(await readFile(join(linked, "inbox", "controlled.md"), "utf8"))
        .toBe("controlled\n");
      expect(await statusMatrix(linked)).toContainEqual(["linked-staged.md", 0, 2, 2]);

      const inbox = tree.tree.find((entry) => entry.path === "inbox");
      expect(inbox?.type).toBe("tree");
      const inboxTree = await readTree({ path: linked, oid: inbox!.oid });
      const capturedBlob = inboxTree.tree.find((entry) => entry.path === "captured.md");
      expect(await readBlobByOid({ path: linked, oid: capturedBlob!.oid })).toBe(captured);

      expect(await readRefResult({ path: linked, ref: "refs/dome/test" })).toEqual({ kind: "missing" });
      await writeRef({ path: linked, ref: "refs/dome/test", value: captureCommit });
      expect(await readRef({ path: linked, ref: "refs/dome/test" })).toBe(captureCommit);

      await writeFile(join(linked, "README.md"), "changed locally\n");
      await expect(checkoutPathsAtRef({
        path: linked,
        ref: initial,
        filepaths: ["README.md"],
        dryRun: true,
      })).rejects.toThrow("would overwrite");
      expect(await readFile(join(linked, "README.md"), "utf8")).toBe("changed locally\n");
      await checkoutPathsAtRef({ path: linked, ref: initial, filepaths: ["README.md"], force: true });
      expect(await readFile(join(linked, "README.md"), "utf8")).toBe("initial\n");

      const hookSentinel = join(fixture, "post-commit-ran");
      const hook = join(main, ".git", "hooks", "post-commit");
      await writeFile(hook, `#!/bin/sh\nprintf ran > '${hookSentinel}'\n`);
      await chmod(hook, 0o755);
      await writeFile(join(linked, "ordinary.md"), "ordinary\n");
      const ordinaryMessage = "ordinary linked commit\n\nDome-Run: run-linked\n";
      const ordinary = await commit({ path: linked, message: ordinaryMessage, files: ["ordinary.md"] });
      expect(await readFile(hookSentinel, "utf8").catch(() => null)).toBeNull();
      expect((await log({ path: linked, depth: 1 }))[0]?.commit.message).toBe(ordinaryMessage);

      await writeFile(join(linked, "retry.md"), "retry\n");
      let raced = false;
      const retried = await commitFilesOnHead({
        path: linked,
        files: [{ filepath: "retry.md", content: "retry\n" }],
        message: "retry capture",
        beforeRefAdvance: async (attempt) => {
          if (attempt !== 1) return;
          raced = true;
          await writeFile(join(linked, "concurrent.md"), "concurrent\n");
          await commit({ path: linked, message: "concurrent", files: ["concurrent.md"] });
        },
      });
      expect(raced).toBeTrue();
      expect(await isAncestor({ path: linked, ancestor: ordinary, descendant: retried })).toBeTrue();
      await rm(join(linked, "retry.md"));
      const deleted = await commitFilesOnHead({
        path: linked,
        files: [{ filepath: "retry.md", content: null }],
        message: "delete retry file",
      });
      expect(await readBlob({ path: linked, commit: deleted, filepath: "retry.md" })).toBeNull();
      await writeFile(join(linked, "retry.md"), "untracked replacement\n");
      await expect(checkoutPathsAtRef({
        path: linked,
        ref: deleted,
        filepaths: ["retry.md"],
        dryRun: true,
      })).rejects.toThrow("would overwrite");
      expect(await readFile(join(linked, "retry.md"), "utf8")).toBe("untracked replacement\n");

      // Common objects/refs are visible from main, but its branch, worktree,
      // and index remain exactly where they were.
      expect(await currentBranch(main)).toBe("main");
      expect(await currentSha(main)).toBe(initial);
      expect(await nativeGit(main, "rev-parse", "main")).toBe(initial);
      expect(await nativeGit(main, "status", "--porcelain")).toBe("A  main-staged.md");
      expect(await nativeGit(main, "cat-file", "-t", captureCommit)).toBe("commit");
      expect(await readBlob({ path: main, commit: initial, filepath: "inbox/captured.md" })).toBeNull();
      expect(Buffer.compare(await readFile(join(main, ".git", "index")), mainIndexBefore)).toBe(0);
      expect(await readFile(join(main, "README.md"), "utf8")).toBe("initial\n");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("rejects an unmerged linked index instead of returning lossy status codes", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "dome-linked-conflict-"));
    const main = join(fixture, "main");
    const linked = join(fixture, "linked");
    try {
      await mkdir(main);
      await nativeGit(main, "init", "-q", "-b", "main");
      await nativeGit(main, "config", "user.name", "Fixture");
      await nativeGit(main, "config", "user.email", "fixture@example.com");
      await writeFile(join(main, "conflict.md"), "base\n");
      await nativeGit(main, "add", ".");
      await nativeGit(main, "commit", "-qm", "base");
      await nativeGit(main, "worktree", "add", "-q", "-b", "linked", linked);
      await writeFile(join(linked, "conflict.md"), "linked\n");
      await nativeGit(linked, "commit", "-qam", "linked");
      await writeFile(join(main, "conflict.md"), "main\n");
      await nativeGit(main, "commit", "-qam", "main");
      await expect(nativeGit(linked, "merge", "main")).rejects.toThrow();
      await expect(statusMatrix(linked)).rejects.toThrow("unmerged index");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("rejects malformed gitfiles and supports a valid non-linked gitfile", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "dome-gitfile-"));
    const malformed = join(fixture, "malformed");
    const work = join(fixture, "work");
    const gitdir = join(fixture, "separate.git");
    try {
      await mkdir(malformed);
      await writeFile(join(malformed, ".git"), "gitdir: ../missing.git\n");
      expect(await findGitRoot(malformed)).toBeNull();
      expect(await isGitRepo(malformed)).toBeFalse();

      await mkdir(work);
      await nativeGit(fixture, "init", "-q", "-b", "main", `--separate-git-dir=${gitdir}`, work);
      await nativeGit(work, "config", "user.name", "Fixture");
      await nativeGit(work, "config", "user.email", "fixture@example.com");
      await writeFile(join(work, "file.md"), "gitfile\n");
      expect(await isGitRepo(work)).toBeTrue();
      expect(await currentBranch(work)).toBe("main");
      expect(await currentSha(work)).toBeNull();
      const initial = await commit({
        path: work,
        message: "initial gitfile commit\n",
        files: ["file.md"],
      });
      expect(await currentSha(work)).toBe(initial);
      expect((await log({ path: work, depth: 1 }))[0]?.commit.message).toBe("initial gitfile commit\n");
      expect((await readTree({ path: work, oid: initial })).tree.map((entry) => entry.path)).toEqual(["file.md"]);
      await expect(initRepo(work, "other")).rejects.toThrow("cannot initialize");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("rejects signed commits rather than returning a mismatched log shape", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "dome-linked-signed-"));
    const main = join(fixture, "main");
    const linked = join(fixture, "linked");
    try {
      await mkdir(main);
      await nativeGit(main, "init", "-q", "-b", "main");
      await nativeGit(main, "config", "user.name", "Fixture");
      await nativeGit(main, "config", "user.email", "fixture@example.com");
      await writeFile(join(main, "file.md"), "base\n");
      await nativeGit(main, "add", ".");
      await nativeGit(main, "commit", "-qm", "base");
      await nativeGit(main, "worktree", "add", "-q", "-b", "linked", linked);
      const parent = await nativeGit(linked, "rev-parse", "HEAD");
      const tree = await nativeGit(linked, "rev-parse", "HEAD^{tree}");
      const raw =
        `tree ${tree}\nparent ${parent}\n` +
        "author Fixture <fixture@example.com> 1 +0000\n" +
        "committer Fixture <fixture@example.com> 1 +0000\n" +
        "gpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\n" +
        "fabricated signed commit\n";
      const signed = await nativeGitInput(linked, raw, "hash-object", "-t", "commit", "-w", "--stdin");
      await nativeGit(linked, "update-ref", "refs/heads/linked", signed, parent);
      await expect(log({ path: linked, depth: 1 })).rejects.toThrow("does not support signed commit");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("captures and adopts on the linked branch end to end", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "dome-linked-adopt-"));
    const main = join(fixture, "main");
    const linked = join(fixture, "linked");
    const ledger = await openTestLedger();
    try {
      await mkdir(main);
      await nativeGit(main, "init", "-q", "-b", "main");
      await nativeGit(main, "config", "user.name", "Fixture");
      await nativeGit(main, "config", "user.email", "fixture@example.com");
      await mkdir(join(main, ".dome"));
      await writeFile(join(main, ".dome", "config.yaml"), "version: 1\n");
      await writeFile(join(main, "seed.md"), "seed\n");
      await nativeGit(main, "add", ".");
      await nativeGit(main, "commit", "-qm", "base");
      const base = await nativeGit(main, "rev-parse", "HEAD");
      await nativeGit(main, "worktree", "add", "-q", "-b", "linked", linked);
      await writeRef({ path: linked, ref: "refs/dome/adopted/linked", value: base });
      const mainIndexBefore = await readFile(join(main, ".git", "index"));

      const captured = await performCapture(
        {
          vault: linked,
          text: "A linked worktree product thought",
          title: "linked thought",
          captureId: "linked-capture-1",
        },
        { now: () => new Date("2026-07-11T12:00:00.000Z") },
      );
      expect(captured.kind).toBe("captured");
      if (captured.kind !== "captured") throw new Error(`capture failed: ${captured.kind}`);
      const captureHead = captured.result.commit;
      expect(await performCapture(
        {
          vault: linked,
          text: "A linked worktree product thought",
          captureId: "linked-capture-1",
        },
        { now: () => new Date("2026-07-11T12:01:00.000Z") },
      )).toMatchObject({ kind: "duplicate", path: captured.result.path });
      const result = await adopt({
        vault: { path: linked, config: { git: { auto_commit_workflows: true } } },
        proposal: makeManualProposal({
          id: "prop_linked_capture",
          base: commitOid(base),
          head: commitOid(captureHead),
          branch: "linked",
        }),
        runAdoptionProcessors: async () => [],
        sinks: noopSinks(),
        ledger,
      });

      expect(result.adopted).toBeTrue();
      expect(await currentSha(linked)).toBe(captureHead);
      expect(await readRef({ path: linked, ref: "refs/dome/adopted/linked" })).toBe(captureHead);
      expect(await readBlob({
        path: linked,
        commit: captureHead,
        filepath: captured.result.path,
      })).toContain("A linked worktree product thought");
      expect(await currentSha(main)).toBe(base);
      expect(Buffer.compare(await readFile(join(main, ".git", "index")), mainIndexBefore)).toBe(0);
    } finally {
      ledger.close();
      await rm(fixture, { recursive: true, force: true });
    }
  // This end-to-end case owns linked-worktree creation, seven native Git
  // children, two capture attempts, and adoption. Bun's 5s unit default is
  // narrower than that integration boundary on hosted macOS.
  }, 10_000);
});
