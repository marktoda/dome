import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { commit, currentSha } from "../../src/git";
import { makeTestVault } from "../helpers/make-test-vault";

describe("VAULT_IS_GIT_REPO", () => {
  test("openVault on a non-git directory returns vault-not-git-repo", async () => {
    const v = await makeTestVault({ initGit: false });
    try {
      const result = await openVault(v.path);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("vault-not-git-repo");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("openVault on a non-Dome directory (no .dome/) returns vault-not-git-repo or config-invalid", async () => {
    const v = await makeTestVault({ initGit: false, initDome: false });
    try {
      const result = await openVault(v.path);
      expect(result.ok).toBe(false);
    } finally {
      await v.cleanup();
    }
  });

  test("openVault on a valid git+dome directory succeeds", async () => {
    const v = await makeTestVault();
    try {
      const result = await openVault(v.path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.path).toBe(v.path);
      }
    } finally {
      await v.cleanup();
    }
  });

  test("openVault succeeds when vault is a subdirectory of an outer git repo (dogfood case)", async () => {
    // Outer dir has .git/ but no .dome/; inner subdir has .dome/ but no .git/.
    // This is the Dome repo dogfooding its own docs/ as a Dome vault.
    const v = await makeTestVault({ initGit: true, initDome: false });
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const innerPath = join(v.path, "docs");
      await mkdir(join(innerPath, ".dome", "state"), { recursive: true });
      await writeFile(
        join(innerPath, ".dome", "config.yaml"),
        "invariants: {}\nhooks:\n  builtin: {}\n  max_causation_depth: 50\ngit:\n  auto_commit_workflows: true\n",
      );
      await writeFile(
        join(innerPath, ".dome", "page-types.yaml"),
        "defaults: [entity]\nextensions: []\n",
      );
      const result = await openVault(innerPath);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.path).toBe(innerPath);
    } finally {
      await v.cleanup();
    }
  });

  test("findGitRoot walks past partial .git/ (objects + index but no HEAD) to the real outer git", async () => {
    // Regression: pre-fix `dome lint` runs that errored mid-commit left a
    // partial `.git/` directory (objects/, index, but no HEAD) inside the
    // dogfood-mode vault. The old findGitRoot stopped at any `.git`,
    // including this corrupt one, and every subsequent git call exploded
    // on the missing HEAD. The fix: require .git/HEAD on directory entries.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { findGitRoot } = await import("../../src/git");

    const v = await makeTestVault({ initGit: true, initDome: false });
    try {
      const innerPath = join(v.path, "docs");
      await mkdir(join(innerPath, ".git", "objects"), { recursive: true });
      await writeFile(join(innerPath, ".git", "index"), "stub-index-content");
      // Note: no .git/HEAD written in innerPath/.git/

      const discovered = await findGitRoot(innerPath);
      // The partial inner .git/ must be ignored; the walk continues to the
      // outer (real) .git/ which has HEAD.
      expect(discovered).toBe(v.path);
    } finally {
      await v.cleanup();
    }
  });

  test("git operations (commit, currentSha) succeed when vault is a subdirectory of an outer git repo", async () => {
    // The test gap that let the dogfood-case bug ship: openVault accepted
    // the subdir but every subsequent git operation passed `dir: vault.path`
    // (the inner subdir) to isomorphic-git, which looked for `<subdir>/.git/`
    // and exploded with `null is not an object` on the missing HEAD file.
    // The fix: src/git.ts helpers resolve gitRoot internally and translate
    // vault-relative paths to outer-root-relative.
    const v = await makeTestVault({ initGit: true, initDome: false });
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const innerPath = join(v.path, "docs");
      await mkdir(join(innerPath, ".dome", "state"), { recursive: true });
      await writeFile(
        join(innerPath, ".dome", "config.yaml"),
        "invariants: {}\nhooks:\n  builtin: {}\n  max_causation_depth: 50\ngit:\n  auto_commit_workflows: true\n",
      );
      await writeFile(
        join(innerPath, ".dome", "page-types.yaml"),
        "defaults: [entity]\nextensions: []\n",
      );

      // Write a vault-relative file and commit it. `commit({ path: innerPath })`
      // must walk up to find the outer .git/, prefix "log.md" with "docs/" so
      // git.add resolves against the outer worktree, and return a fresh SHA.
      await writeFile(join(innerPath, "log.md"), "# Log\n");
      const sha = await commit({
        path: innerPath,
        message: "test: dogfood-mode commit",
        files: ["log.md"],
      });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      // currentSha on the inner path returns the just-committed SHA (reads
      // outer .git/HEAD via the same gitRoot resolution).
      const head = await currentSha(innerPath);
      expect(head).toBe(sha);
    } finally {
      await v.cleanup();
    }
  });
});
