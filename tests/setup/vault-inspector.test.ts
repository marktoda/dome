import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SETUP_VAULT_INSPECTION_CAPS,
  inspectSetupVaultSource,
  sameExactFilesystemObject,
  type SetupGitRunner,
} from "../../src/setup/vault-inspector";
import type { SetupRepositoryCandidate } from "../../src/setup/repository-policy";

function withoutRepositoryProofs(rows: ReadonlyArray<SetupRepositoryCandidate>) {
  return rows.map(({ proofSha256: _proof, contentSha256: _content, gitMode: _mode, ...row }) => row);
}
import {
  VAULT_ASSESSMENT_SCHEMA,
  validateVaultAssessment,
  type VaultAssessment,
} from "../../src/setup/contracts";
import { defaultConfigYaml } from "../../src/cli/default-vault-config";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("read-only setup vault inspector", () => {
  test("compares live filesystem identities without Git's uint32 truncation", () => {
    const left = { dev: 1n, ino: 7n };
    expect(sameExactFilesystemObject(left, { ...left })).toBe(true);
    expect(sameExactFilesystemObject(left, { dev: 1n, ino: 7n + 0x1_0000_0000n })).toBe(false);
    expect(sameExactFilesystemObject(left, { dev: 1n + 0x1_0000_0000n, ino: 7n })).toBe(false);
  });

  test("classifies new, empty, and existing non-Git paths without creating state", async () => {
    const root = await temporary();
    const missing = join(root, "missing");
    const empty = join(root, "empty");
    const existing = join(root, "existing");
    await mkdir(empty);
    await mkdir(existing);
    await writeFile(join(existing, "Note.md"), "# Existing\n");

    expect((await inspectSetupVaultSource(missing)).kind).toBe("new-path");
    expect((await inspectSetupVaultSource(empty)).kind).toBe("empty-directory");
    const inspected = await inspectSetupVaultSource(existing);
    expect(inspected.kind).toBe("existing-non-git-vault");
    expect(inspected.markdown).toEqual({ tracked: [], untracked: ["Note.md"] });
  });

  test("fails closed when a missing or empty target is created or populated after Target1", async () => {
    const root = await temporary();
    const missing = join(root, "missing");
    const created = await inspectSetupVaultSource(missing, {
      proofCheckpoint: async (phase) => {
        if (phase === "target-1") await mkdir(missing);
      },
    });
    expect(created.kind).toBe("unsafe-or-ambiguous-state");
    expect(created.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state"]);

    const empty = join(root, "empty");
    await mkdir(empty);
    const populated = await inspectSetupVaultSource(empty, {
      proofCheckpoint: async (phase) => {
        if (phase === "target-1") await writeFile(join(empty, "Appeared.md"), "appeared\n");
      },
    });
    expect(populated.kind).toBe("unsafe-or-ambiguous-state");
    expect(populated.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state"]);
  });

  test("fails closed when a selected-path component becomes a symlink after Target1", async () => {
    const root = await temporary();
    const parent = join(root, "direct");
    const moved = join(root, "moved");
    const vault = join(parent, "vault");
    await mkdir(vault, { recursive: true });
    const inspected = await inspectSetupVaultSource(vault, {
      proofCheckpoint: async (phase) => {
        if (phase !== "target-1") return;
        await rename(parent, moved);
        await symlink(moved, parent);
      },
    });
    expect(inspected.kind).toBe("unsafe-or-ambiguous-state");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state", "symlink-ambiguity"]);
  });

  test("uses only a direct repository boundary and blocks an ancestor repository", async () => {
    const root = await gitFixture();
    const direct = await inspectSetupVaultSource(root);
    expect(direct.git.direct).toBe(true);
    expect(direct.kind).toBe("existing-git-vault");

    const child = join(root, "NestedVault");
    await mkdir(child);
    await writeFile(join(child, "Nested.md"), "# Nested\n");

    const nested = await inspectSetupVaultSource(child);
    expect(nested.git.direct).toBe(false);
    expect(nested.git.ancestorRoot).toBe(root);
    expect(nested.kind).toBe("unsafe-or-ambiguous-state");
    expect(nested.blockers.map((blocker) => blocker.code)).toEqual(["unsafe-path"]);
  });

  test("recognizes a clean configured Dome vault without opening its runtime", async () => {
    const root = await gitFixture();
    await mkdir(join(root, ".dome"));
    await writeFile(join(root, ".dome", "config.yaml"), "grants: standard\n");
    await git(root, "add", ".dome/config.yaml");
    await git(root, "commit", "-m", "Configure Dome");

    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.kind).toBe("existing-dome-vault");
    expect(inspected.dome.state).toBe("configured");
    expect(inspected.dome.contentScope).toBe("absent");
    expect(inspected.blockers).toEqual([]);
  });

  test("accepts the generated config through the canonical runtime parser on reassessment", async () => {
    const root = await gitFixture();
    await mkdir(join(root, ".dome"));
    await writeFile(join(root, ".dome", "config.yaml"), defaultConfigYaml());
    await git(root, "add", ".dome/config.yaml");
    await git(root, "commit", "-m", "Configure Dome with content scope");

    const first = await inspectSetupVaultSource(root);
    const repeated = await inspectSetupVaultSource(root);
    expect(repeated).toEqual(first);
    expect(first.kind).toBe("existing-dome-vault");
    expect(first.dome).toEqual({ state: "configured", contentScope: "configured" });
    expect(first.blockers).toEqual([]);
  });

  test("fails closed when an existing config carries a malformed content scope", async () => {
    const root = await gitFixture();
    await mkdir(join(root, ".dome"));
    await writeFile(join(root, ".dome", "config.yaml"), `
grants: standard
content_scope:
  version: 1
  include: ["**/*.md", "**/*.md"]
  exclude: []
`);
    await git(root, "add", ".dome/config.yaml");
    await git(root, "commit", "-m", "Add malformed content scope");

    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.dome).toEqual({ state: "incompatible", contentScope: "incompatible" });
    expect(inspected.kind).toBe("unsafe-or-ambiguous-state");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state"]);
  });

  test("accepts a strict managed scope document when the base config has no inline scope", async () => {
    const root = await gitFixture();
    await mkdir(join(root, ".dome"));
    await writeFile(join(root, ".dome", "config.yaml"), "grants: standard\n");
    await writeFile(join(root, ".dome", "content-scope.yaml"), `content_scope:\n  version: 1\n  include: ["notes/**/*.md"]\n  exclude: [".dome/**", ".git/**"]\n`);
    await git(root, "add", ".dome/config.yaml", ".dome/content-scope.yaml");
    await git(root, "commit", "-m", "Configure Dome policy documents");

    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.dome).toEqual({ state: "configured", contentScope: "configured" });
    expect(inspected.blockers).toEqual([]);
  });

  test("fails closed on orphan, malformed, and conflicting managed scope documents", async () => {
    for (const fixture of [
      {
        base: null,
        overlay: `content_scope:\n  version: 1\n  include: ["notes/**/*.md"]\n  exclude: [".dome/**", ".git/**"]\n`,
      },
      {
        base: "grants: standard\n",
        overlay: `content_scope:\n  version: 1\n  include: ["notes/**/*.md"]\n  exclude: []\nextensions: {}\n`,
      },
      {
        base: defaultConfigYaml(),
        overlay: `content_scope:\n  version: 1\n  include: ["notes/**/*.md"]\n  exclude: [".dome/**", ".git/**"]\n`,
      },
    ]) {
      const root = await gitFixture();
      await mkdir(join(root, ".dome"));
      if (fixture.base !== null) await writeFile(join(root, ".dome", "config.yaml"), fixture.base);
      await writeFile(join(root, ".dome", "content-scope.yaml"), fixture.overlay);
      await git(root, "add", ".dome");
      await git(root, "commit", "-m", "Add incompatible policy documents");

      const inspected = await inspectSetupVaultSource(root);
      expect(inspected.dome).toEqual({ state: "incompatible", contentScope: "incompatible" });
      expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state"]);
    }
  });

  test("accepts a direct linked worktree without adopting its owner repository", async () => {
    const owner = await gitFixture();
    const linked = `${owner}-linked`;
    temporaryRoots.push(linked);
    await git(owner, "worktree", "add", "-b", "linked", linked);

    const inspected = await inspectSetupVaultSource(linked);
    expect(inspected.git.direct).toBe(true);
    expect(inspected.git.ancestorRoot).toBeNull();
    expect(inspected.git.branch).toBe("linked");
    expect(inspected.kind).toBe("existing-git-vault");
    expect(inspected.blockers).toEqual([]);
  });

  test("is deterministic and changes for tracked worktree bytes", async () => {
    const root = await gitFixture();
    const first = await inspectSetupVaultSource(root);
    const repeated = await inspectSetupVaultSource(root);
    expect(repeated).toEqual(first);

    await writeFile(join(root, "README.md"), "# Changed\n");
    const changed = await inspectSetupVaultSource(root);
    expect(changed.worktreeFingerprint).not.toBe(first.worktreeFingerprint);
    expect(changed.git.state).toBe("dirty");
    expect(changed.blockers.map((blocker) => blocker.code)).toEqual(["dirty-worktree"]);
  });

  test("derives staged and executable-mode dirtiness without porcelain status", async () => {
    const root = await gitFixture();
    const clean = await inspectSetupVaultSource(root);
    await writeFile(join(root, "README.md"), "# Staged\n");
    await git(root, "add", "README.md");
    const staged = await inspectSetupVaultSource(root);
    expect(staged.git.state).toBe("dirty");
    expect(staged.worktreeFingerprint).not.toBe(clean.worktreeFingerprint);

    await git(root, "reset", "--hard", "HEAD");
    await chmod(join(root, "README.md"), 0o755);
    const executable = await inspectSetupVaultSource(root);
    expect(executable.git.state).toBe("dirty");
    expect(executable.worktreeFingerprint).not.toBe(clean.worktreeFingerprint);
  });

  test("changes for untracked bytes while keeping Markdown inventory exact", async () => {
    const root = await gitFixture();
    await writeFile(join(root, "Scratch.md"), "one\n");
    await writeFile(join(root, "CaseVariant.MD"), "outside the version-1 Markdown universe\n");
    const first = await inspectSetupVaultSource(root);
    expect(first.markdown.untracked).toEqual(["Scratch.md"]);

    await writeFile(join(root, "Scratch.md"), "two\n");
    const changed = await inspectSetupVaultSource(root);
    expect(changed.worktreeFingerprint).not.toBe(first.worktreeFingerprint);
    expect(changed.markdown.untracked).toEqual(["Scratch.md"]);
  });

  test("inventories only lowercase-suffix Markdown for tracked and non-Git vaults", async () => {
    const tracked = await gitFixture();
    await writeFile(join(tracked, "lowercase.md"), "included\n");
    await writeFile(join(tracked, "case-variant.MD"), "excluded\n");
    await git(tracked, "add", "lowercase.md", "case-variant.MD");
    await git(tracked, "commit", "-m", "Add case-sensitive inventory fixture");
    expect((await inspectSetupVaultSource(tracked)).markdown.tracked).toEqual(["README.md", "lowercase.md"]);

    const nonGit = await temporary();
    await writeFile(join(nonGit, "lowercase.md"), "included\n");
    await writeFile(join(nonGit, "case-variant.MD"), "excluded\n");
    expect((await inspectSetupVaultSource(nonGit)).markdown.untracked).toEqual(["lowercase.md"]);
  });

  test("binds ignore behavior and direct info/exclude bytes", async () => {
    const root = await gitFixture();
    await writeFile(join(root, "Secret.md"), "ignored owner content\n");
    await writeFile(join(root, ".git", "info", "exclude"), "Secret.md\n");
    const ignored = await inspectSetupVaultSource(root);
    expect(ignored.markdown.untracked).toEqual([]);
    expect(ignored.kind).toBe("existing-git-vault");
    expect(ignored.blockers).toEqual([]);

    await writeFile(join(root, ".git", "info", "exclude"), "Other.md\n");
    const visible = await inspectSetupVaultSource(root);
    expect(visible.worktreeFingerprint).not.toBe(ignored.worktreeFingerprint);
    expect(visible.markdown.untracked).toEqual(["Secret.md"]);
  });

  test("accepts exactly slash-terminated ignored-directory inventory", async () => {
    const root = await gitFixture();
    await writeFile(join(root, ".gitignore"), "cache/\n");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-m", "Ignore cache");
    await mkdir(join(root, "cache"));
    await writeFile(join(root, "cache", "Secret.md"), "ignored\n");

    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.kind).toBe("existing-git-vault");
    expect(inspected.markdown.untracked).toEqual([]);
    expect(inspected.blockers).toEqual([]);
  });

  test("rejects ignored-directory inventory with more than one terminal slash", async () => {
    const root = await gitFixture();
    const runner: SetupGitRunner = async (args, cwd, caps) => {
      const result = await nativeGitRunner(args, cwd, caps);
      return args.includes("--directory")
        ? { ...result, stdout: Buffer.from("cache//\0") }
        : result;
    };
    const inspected = await inspectSetupVaultSource(root, { runGit: runner });
    expect(inspected.git.state).toBe("ambiguous");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state"]);
  });

  test("never follows symlinks and fingerprints their exact targets", async () => {
    const root = await temporary();
    await writeFile(join(root, "A.md"), "A\n");
    await writeFile(join(root, "B.md"), "B\n");
    await symlink("A.md", join(root, "Pointer.md"));
    const first = await inspectSetupVaultSource(root);
    expect(first.blockers.map((blocker) => blocker.code)).toEqual(["symlink-ambiguity"]);

    await unlink(join(root, "Pointer.md"));
    await symlink("B.md", join(root, "Pointer.md"));
    const changed = await inspectSetupVaultSource(root);
    expect(changed.worktreeFingerprint).not.toBe(first.worktreeFingerprint);
    expect(changed.kind).toBe("unsafe-or-ambiguous-state");
  });

  test("rejects existing and missing vaults beneath a symlinked ancestor", async () => {
    const root = await temporary();
    const direct = join(root, "direct");
    const redirected = join(root, "redirected");
    await mkdir(direct);
    await mkdir(join(direct, "existing"));
    await symlink(direct, redirected);

    let redirectedExisting: Awaited<ReturnType<typeof inspectSetupVaultSource>> | undefined;
    for (const target of [join(redirected, "existing"), join(redirected, "missing")]) {
      const inspected = await inspectSetupVaultSource(target);
      if (target.endsWith("/existing")) redirectedExisting = inspected;
      expect(inspected.targetPath).toBe(target);
      expect(inspected.kind).toBe("unsafe-or-ambiguous-state");
      expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["symlink-ambiguity"]);
    }

    await unlink(redirected);
    await mkdir(join(redirected, "existing"), { recursive: true });
    const directExisting = await inspectSetupVaultSource(join(redirected, "existing"));
    expect(directExisting.kind).toBe("empty-directory");
    expect(directExisting.worktreeFingerprint).not.toBe(redirectedExisting?.worktreeFingerprint);
  });

  test("rejects a redirected direct .git entry", async () => {
    const root = await temporary();
    const gitDir = join(root, "git-data");
    const vault = join(root, "vault");
    await mkdir(gitDir);
    await mkdir(vault);
    await symlink(gitDir, join(vault, ".git"));

    const inspected = await inspectSetupVaultSource(vault);
    expect(inspected.git.state).toBe("ambiguous");
    expect(inspected.kind).toBe("unsafe-or-ambiguous-state");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state"]);
  });

  test("blocks nested .git files and directories", async () => {
    for (const kind of ["file", "directory"] as const) {
      const root = await temporary();
      await mkdir(join(root, "Nested"));
      if (kind === "file") await writeFile(join(root, "Nested", ".git"), "gitdir: elsewhere\n");
      else await mkdir(join(root, "Nested", ".git"));
      const inspected = await inspectSetupVaultSource(root);
      expect(inspected.kind).toBe("unsafe-or-ambiguous-state");
      expect(inspected.blockers.map((blocker) => blocker.code)).toContain("unsafe-path");
    }
  });

  test("lstats and blocks reserved .dome/state symlinks and special files", async () => {
    const symlinkRoot = await temporary();
    const outside = await temporary();
    await mkdir(join(symlinkRoot, ".dome"));
    await symlink(outside, join(symlinkRoot, ".dome", "state"));
    const linkedState = await inspectSetupVaultSource(symlinkRoot);
    expect(linkedState.blockers.map((blocker) => blocker.code)).toEqual(["symlink-ambiguity", "unsafe-path"]);

    const specialRoot = await temporary();
    await mkdir(join(specialRoot, ".dome"));
    const fifo = join(specialRoot, ".dome", "state");
    const process = Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "pipe" });
    expect(await process.exited).toBe(0);
    const specialState = await inspectSetupVaultSource(specialRoot);
    expect(specialState.blockers.map((blocker) => blocker.code)).toEqual(["unsafe-path"]);
  });

  test("blocks hard links and binds exact file identity evidence", async () => {
    const root = await temporary();
    await writeFile(join(root, "Owner.md"), "owner\n");
    await link(join(root, "Owner.md"), join(root, "Alias.md"));
    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.kind).toBe("unsafe-or-ambiguous-state");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["unsafe-path"]);
  });

  test("structural hard-link safety dominates owner ignore classification", async () => {
    const root = await temporary();
    const outside = await temporary();
    await writeFile(join(root, ".gitignore"), "*.bin\n");
    await writeFile(join(outside, "owner.bin"), "external owner\n");
    await link(join(outside, "owner.bin"), join(root, "ignored.bin"));

    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["unsafe-path"]);
    expect(inspected.repository.candidates.find(({ path }) => path === "ignored.bin")).toEqual(expect.objectContaining({
      path: "ignored.bin", kind: "file", bytes: 15, tracking: "ignored",
      disposition: "blocked", reason: "hard-linked-file",
    }));
  });

  test("fails closed for active Git operations", async () => {
    const root = await gitFixture();
    await mkdir(join(root, ".git", "rebase-merge"));
    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.git.state).toBe("operation-active");
    expect(inspected.git.operationMarkers).toContain("rebase-merge");
    expect(inspected.kind).toBe("incompatible-active-operation");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["active-git-operation"]);
  });

  test("distinguishes detached and unborn repositories", async () => {
    const detachedRoot = await gitFixture();
    await git(detachedRoot, "checkout", "--detach", "--quiet");
    const detached = await inspectSetupVaultSource(detachedRoot);
    expect(detached.git.state).toBe("detached");
    expect(detached.git.head).toMatch(/^[0-9a-f]{40}$/);
    expect(detached.git.branch).toBeNull();
    expect(detached.blockers.map((blocker) => blocker.code)).toEqual(["detached-head"]);

    const unbornRoot = await temporary();
    await git(unbornRoot, "init", "-b", "main");
    const unborn = await inspectSetupVaultSource(unbornRoot);
    expect(unborn.git.state).toBe("unborn");
    expect(unborn.git.head).toBeNull();
    expect(unborn.git.branch).toBe("main");
    expect(unborn.blockers.map((blocker) => blocker.code)).toEqual(["unborn-repository"]);
  });

  test("blocks bounded inventories instead of reading oversized content", async () => {
    const root = await temporary();
    await writeFile(join(root, "large.bin"), Buffer.alloc(32, 1));
    const inspected = await inspectSetupVaultSource(root, {
      caps: { fileBytes: 8, totalBytes: 16 },
    });
    expect(inspected.kind).toBe("unsafe-or-ambiguous-state");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["unsafe-path"]);
  });

  test("exposes a content-free baseline inventory and never reads sensitive-name candidates", async () => {
    const root = await temporary();
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "safe.md"), "#\n");
    await writeFile(join(root, ".env.production"), "TOP_SECRET=must-not-be-read\n");
    await writeFile(join(root, "private-key.pem"), "must-not-be-read\n");
    await mkdir(join(root, "secrets"));
    await writeFile(join(root, "secrets", "opaque.bin"), "must-not-be-read\n");

    const inspected = await inspectSetupVaultSource(root, {
      // Both sensitive files exceed this read budget. Their name policy must
      // classify them before hashing, so setup remains ready and content-free.
      caps: { fileBytes: 8 },
    });

    expect(inspected.blockers).toEqual([]);
    expect(inspected.repository.baselineTracked).toEqual(["notes/safe.md"]);
    expect(withoutRepositoryProofs(inspected.repository.candidates)).toEqual([
      {
        path: ".env.production", kind: "file", bytes: 28, tracking: "other",
        disposition: "preserve-untracked", reason: "sensitive-name",
      },
      {
        path: "notes", kind: "directory", bytes: 0, tracking: "other",
        disposition: "preserve-untracked", reason: "directory-not-tracked",
      },
      {
        path: "notes/safe.md", kind: "file", bytes: 2, tracking: "other",
        disposition: "baseline", reason: "safe-owner-file",
      },
      {
        path: "private-key.pem", kind: "file", bytes: 17, tracking: "other",
        disposition: "preserve-untracked", reason: "sensitive-name",
      },
      {
        path: "secrets", kind: "directory", bytes: 0, tracking: "other",
        disposition: "preserve-untracked", reason: "sensitive-name",
      },
      {
        path: "secrets/opaque.bin", kind: "file", bytes: 17, tracking: "other",
        disposition: "preserve-untracked", reason: "sensitive-name",
      },
    ]);
  });

  test("proposes only bounded direct owner files for a non-Git baseline", async () => {
    const root = await temporary();
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "one.md"), "# One\n");
    await writeFile(join(root, "attachment.png"), "png bytes\n");
    await writeFile(join(root, "credentials.json"), "{}\n");

    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.repository.baselineTracked).toEqual(["attachment.png", "notes/one.md"]);
    expect(inspected.repository.candidates.map(({ path, disposition, reason }) => ({ path, disposition, reason }))).toEqual([
      { path: "attachment.png", disposition: "baseline", reason: "safe-owner-file" },
      { path: "credentials.json", disposition: "preserve-untracked", reason: "sensitive-name" },
      { path: "notes", disposition: "preserve-untracked", reason: "directory-not-tracked" },
      { path: "notes/one.md", disposition: "baseline", reason: "safe-owner-file" },
    ]);
  });

  test("keeps tracked sensitive files content-free without inventing dirtiness", async () => {
    const root = await gitFixture();
    await writeFile(join(root, ".env"), "SECRET=owner-only\n");
    await git(root, "add", ".env");
    await git(root, "commit", "-m", "Track owner environment");

    const clean = await inspectSetupVaultSource(root);
    expect(clean.git.state).toBe("clean");
    expect(clean.repository.candidates.find((candidate) => candidate.path === ".env")).toEqual(expect.objectContaining({
      path: ".env", kind: "file", bytes: 18, tracking: "tracked",
      disposition: "already-tracked", reason: "sensitive-name",
    }));
    expect(JSON.stringify(clean.repository)).not.toContain("owner-only");

    await writeFile(join(root, ".env"), "SECRET=changed!!!\n");
    const dirty = await inspectSetupVaultSource(root);
    expect(dirty.git.state).toBe("dirty");
    expect(dirty.blockers.map((blocker) => blocker.code)).toContain("dirty-worktree");
  });

  test("applies exact owner gitignore semantics before proposing a non-Git baseline", async () => {
    const root = await temporary();
    await writeFile(join(root, ".gitignore"), [
      "cache/", "*.tmp", "!important.tmp", "node_modules/*", "!node_modules/keep.md", "",
    ].join("\n"));
    await mkdir(join(root, "cache"));
    await writeFile(join(root, "cache", "drop.md"), "x".repeat(1_024));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "drop.js"), "x".repeat(1_024));
    await writeFile(join(root, "node_modules", "keep.md"), "# Kept\n");
    await writeFile(join(root, "draft.tmp"), "ignored\n");
    await writeFile(join(root, "important.tmp"), "kept\n");
    await writeFile(join(root, "Owner.md"), "# Owner\n");

    const inspected = await inspectSetupVaultSource(root, { caps: { fileBytes: 128 } });
    expect(inspected.blockers).toEqual([]);
    expect(inspected.repository.baselineTracked).toEqual([
      ".gitignore", "Owner.md", "important.tmp", "node_modules/keep.md",
    ]);
    const ignored = inspected.repository.candidates.filter((candidate) => candidate.tracking === "ignored");
    expect(ignored.map((candidate) => candidate.path)).toEqual([
      "cache", "draft.tmp", "node_modules/drop.js",
    ]);
    expect(ignored.every((candidate) => candidate.reason === "ignored-by-owner" &&
      candidate.disposition === "preserve-untracked")).toBe(true);
  });

  test("applies nested owner gitignore rules with deeper negation precedence", async () => {
    const root = await temporary();
    await writeFile(join(root, ".gitignore"), ["nested/*.md", "*.tmp", ""].join("\n"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", ".gitignore"), ["!local-keep.md", "*.log", "!important.log", ""].join("\n"));
    await writeFile(join(root, "nested", "drop.md"), "ignored\n");
    await writeFile(join(root, "nested", "local-keep.md"), "kept\n");
    await writeFile(join(root, "nested", "drop.log"), "ignored\n");
    await writeFile(join(root, "nested", "important.log"), "kept\n");
    await writeFile(join(root, "nested", "drop.tmp"), "ignored\n");

    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.blockers).toEqual([]);
    expect(inspected.repository.baselineTracked).toEqual([
      ".gitignore", "nested/.gitignore", "nested/important.log", "nested/local-keep.md",
    ]);
    expect(inspected.repository.candidates.filter(({ tracking }) => tracking === "ignored").map(({ path }) => path)).toEqual([
      "nested/drop.log", "nested/drop.md", "nested/drop.tmp",
    ]);
    expect(inspected.markdown.untracked).toEqual(["nested/local-keep.md"]);
  });

  test("matches the ignore-case behavior of the repository Git will initialize", async () => {
    const root = await temporary();
    await writeFile(join(root, ".gitignore"), "cache/\n");
    await mkdir(join(root, "Cache"));
    await writeFile(join(root, "Cache", "owner.md"), "owner\n");

    const preview = await inspectSetupVaultSource(root);
    const previewIgnored = preview.repository.candidates.find(({ path }) => path === "Cache")?.tracking === "ignored";
    await git(root, "init", "-b", "main");
    const gitIgnored = await gitExitCode(root, "check-ignore", "--quiet", "Cache/owner.md") === 0;
    expect(previewIgnored).toBe(gitIgnored);
  });

  test("blocks case-variant private roots before reading or traversing them", async () => {
    for (const alias of [".DOME", ".Git", ".dome/STATE"]) {
      const root = await temporary();
      await mkdir(join(root, alias, "state"), { recursive: true });
      await writeFile(join(root, alias, "state", "opaque.bin"), "must-not-be-read\n");
      let gitCommands = 0;
      const inspected = await inspectSetupVaultSource(root, {
        caps: { fileBytes: 1 },
        runGit: async (args, cwd, caps) => {
          gitCommands += 1;
          return await nativeGitRunner(args, cwd, caps);
        },
      });
      expect(gitCommands).toBe(0);
      expect(inspected.blockers.map((blocker) => blocker.code)).toContain("unsafe-path");
      expect(withoutRepositoryProofs(inspected.repository.candidates)).toEqual(alias === ".dome/STATE" ? [{
        path: ".dome", kind: "directory", bytes: 0, tracking: "other",
        disposition: "preserve-untracked", reason: "directory-not-tracked",
      }, {
        path: alias, kind: "directory", bytes: 0, tracking: "other",
        disposition: "blocked", reason: "private-case-alias",
      }] : [{
        path: alias, kind: "directory", bytes: 0, tracking: "other",
        disposition: "blocked", reason: "private-case-alias",
      }]);
    }
  });

  test("does not invoke a configured Git filesystem monitor", async () => {
    const root = await gitFixture();
    const marker = join(root, ".git", "fsmonitor-ran");
    const monitor = join(root, ".git", "hostile-fsmonitor.sh");
    await writeFile(monitor, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(monitor, 0o755);
    await git(root, "config", "core.fsmonitor", monitor);

    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.kind).toBe("existing-git-vault");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("does not invoke clean filters or Git porcelain commands", async () => {
    const root = await gitFixture();
    const marker = join(root, ".git", "clean-filter-ran");
    const filter = join(root, ".git", "hostile-clean.sh");
    await writeFile(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    await chmod(filter, 0o755);
    await writeFile(join(root, ".gitattributes"), "*.md filter=hostile\n");
    await git(root, "add", ".gitattributes");
    await git(root, "commit", "-m", "Configure attributes");
    await git(root, "config", "filter.hostile.clean", filter);
    await git(root, "config", "filter.hostile.required", "true");
    const commands: string[] = [];
    const runner: SetupGitRunner = async (args, cwd, caps) => {
      commands.push(args[0] ?? "");
      return await nativeGitRunner(args, cwd, caps);
    };

    const inspected = await inspectSetupVaultSource(root, { runGit: runner });
    expect(inspected.kind).toBe("existing-git-vault");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect([...new Set(commands)].sort()).toEqual(["ls-files", "ls-tree", "rev-parse", "symbolic-ref"]);
  });

  test("does not lazily fetch a missing promisor object or launch its upload process", async () => {
    const root = await gitFixture();
    const marker = join(root, ".git", "lazy-fetch-ran");
    const uploadPack = join(root, ".git", "hostile-upload-pack.sh");
    await writeFile(uploadPack, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(uploadPack, 0o755);
    await git(root, "config", "remote.origin.url", root);
    await git(root, "config", "remote.origin.promisor", "true");
    await git(root, "config", "remote.origin.uploadpack", uploadPack);
    await git(root, "config", "extensions.partialClone", "origin");
    const tree = await git(root, "rev-parse", "HEAD^{tree}");
    await unlink(join(root, ".git", "objects", tree.slice(0, 2), tree.slice(2)));

    const inspected = await inspectSetupVaultSource(root);
    expect(inspected.git.state).toBe("ambiguous");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state"]);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("fails closed when a nested directory becomes a symlink between coherent scans", async () => {
    const root = await gitFixture();
    const notes = join(root, "Notes");
    await mkdir(notes);
    await writeFile(join(notes, "Owned.md"), "owned\n");
    await git(root, "add", "Notes/Owned.md");
    await git(root, "commit", "-m", "Add notes");
    const outside = await temporary();
    await writeFile(join(outside, "Escaped.md"), "must not be inventoried\n");
    let topLevelProofs = 0;
    const runner: SetupGitRunner = async (args, cwd, caps) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel" && ++topLevelProofs === 2) {
        await rm(notes, { recursive: true });
        await symlink(outside, notes);
      }
      return await nativeGitRunner(args, cwd, caps);
    };

    const inspected = await inspectSetupVaultSource(root, { runGit: runner });
    expect(inspected.kind).toBe("unsafe-or-ambiguous-state");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual([
      "ambiguous-state", "symlink-ambiguity",
    ]);
    expect(inspected.markdown.tracked).toEqual(["Notes/Owned.md", "README.md"]);
    expect(inspected.markdown.untracked).not.toContain("Notes/Escaped.md");
  });

  test("fails closed when the Git index changes after Git2", async () => {
    const root = await gitFixture();
    const inspected = await inspectSetupVaultSource(root, {
      proofCheckpoint: async (phase) => {
        if (phase !== "git-2") return;
        await writeFile(join(root, "README.md"), "# Changed after Git2\n");
        await git(root, "add", "README.md");
      },
    });
    expect(inspected.git.state).toBe("ambiguous");
    expect(inspected.kind).toBe("unsafe-or-ambiguous-state");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state"]);
  });

  test("turns marker-plus-late-failure into a contract-valid ambiguous assessment", async () => {
    const root = await gitFixture();
    await mkdir(join(root, ".git", "rebase-merge"));
    const runner: SetupGitRunner = async (args, cwd, caps) => {
      if (args[0] === "ls-tree") {
        return { exitCode: 1, stdout: Buffer.alloc(0), stderr: "injected after marker" };
      }
      return await nativeGitRunner(args, cwd, caps);
    };
    const inspected = await inspectSetupVaultSource(root, { runGit: runner });
    expect(inspected.git.state).toBe("ambiguous");
    expect(inspected.git.operationMarkers).toContain("rebase-merge");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state"]);
    expect(validateInspectionAssessment(inspected).git.state).toBe("ambiguous");
  });

  test("classifies a late Git proof failure as ambiguous", async () => {
    const root = await gitFixture();
    await writeFile(join(root, "Scratch.md"), "initially dirty\n");
    let topLevelProofs = 0;
    const runner: SetupGitRunner = async (args, cwd, caps) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel" && ++topLevelProofs === 2) {
        return { exitCode: 1, stdout: Buffer.alloc(0), stderr: "injected late failure" };
      }
      return await nativeGitRunner(args, cwd, caps);
    };
    const inspected = await inspectSetupVaultSource(root, { runGit: runner });
    expect(inspected.git.state).toBe("ambiguous");
    expect(inspected.kind).toBe("unsafe-or-ambiguous-state");
    expect(inspected.blockers.map((blocker) => blocker.code)).toEqual(["ambiguous-state"]);
  });

  test("binds injected package or Home selector evidence without inspecting it", async () => {
    const root = await temporary();
    const first = await inspectSetupVaultSource(root, {
      externalFingerprintEvidence: [{ id: "home.selector", sha256: "1".repeat(64) }],
    });
    const repeated = await inspectSetupVaultSource(root, {
      externalFingerprintEvidence: [{ id: "home.selector", sha256: "1".repeat(64) }],
    });
    const changed = await inspectSetupVaultSource(root, {
      externalFingerprintEvidence: [{ id: "home.selector", sha256: "2".repeat(64) }],
    });
    expect(repeated.worktreeFingerprint).toBe(first.worktreeFingerprint);
    expect(changed.worktreeFingerprint).not.toBe(first.worktreeFingerprint);
  });

  test("allows cap overrides only to lower limits and bounds injected evidence", async () => {
    const root = await temporary();
    await expect(inspectSetupVaultSource(root, {
      caps: { entries: SETUP_VAULT_INSPECTION_CAPS.entries + 1 },
    })).rejects.toThrow("may only lower");
    await expect(inspectSetupVaultSource(root, {
      caps: { externalEvidence: 1 },
      externalFingerprintEvidence: [
        { id: "one", sha256: "1".repeat(64) },
        { id: "two", sha256: "2".repeat(64) },
      ],
    })).rejects.toThrow("entry budget");
  });
});

async function temporary(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dome-setup-inspector-")));
  temporaryRoots.push(path);
  return path;
}

async function gitFixture(): Promise<string> {
  const root = await temporary();
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Dome Tests");
  await git(root, "config", "user.email", "dome-tests@example.invalid");
  await writeFile(join(root, "README.md"), "# Vault\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "Initialize vault");
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...globalThis.process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function gitExitCode(cwd: string, ...args: string[]): Promise<number> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...globalThis.process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "ignore",
    stderr: "ignore",
  });
  return await process.exited;
}

function validateInspectionAssessment(
  inspected: Awaited<ReturnType<typeof inspectSetupVaultSource>>,
): VaultAssessment {
  return validateVaultAssessment({
    schema: VAULT_ASSESSMENT_SCHEMA,
    target: { path: inspected.targetPath, state: inspected.targetState, kind: inspected.kind },
    revision: { head: inspected.git.head, worktreeFingerprint: inspected.worktreeFingerprint },
    host: { platform: "darwin", architecture: "arm64" },
    product: {
      packageName: "@marktoda/dome",
      packageVersion: "0.4.0",
      sourceCommit: "1".repeat(40),
      productManifestSha256: "2".repeat(64),
      packagedHome: {
        artifactId: "3".repeat(64),
        productVersion: "0.4.0",
        buildCommit: "1".repeat(40),
        manifestSha256: "4".repeat(64),
      },
    },
    prerequisites: [
      { id: "bun", status: "available", version: "1.2.13" },
      { id: "git", status: "available", version: "2.50.1" },
    ],
    git: { state: inspected.git.state, branch: inspected.git.branch },
    dome: inspected.dome,
    installedHome: {
      state: "absent",
      artifactId: null,
      productVersion: null,
      buildCommit: null,
      manifestSha256: null,
      selectedVaultPath: null,
    },
    markdown: {
      tracked: inspected.markdown.tracked,
      untracked: inspected.markdown.untracked,
      proposedScope: { version: 1, include: ["**/*.md"], exclude: [".dome/**"] },
    },
    repository: inspected.repository,
    blockers: inspected.blockers,
  });
}

const nativeGitRunner: SetupGitRunner = async (args, cwd, caps) => {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...globalThis.process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text(), process.exited,
  ]);
  if (stdout.byteLength > caps.commandBytes) throw new Error("test Git output exceeded cap");
  return { exitCode, stdout: Buffer.from(stdout), stderr };
};
