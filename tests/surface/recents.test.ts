// buildRecents — recently-touched knowledge pages collector.
// Hermetic: real temp vault, runInit scaffold + real git commits for each
// knowledge page under wiki/entities/, wiki/concepts/, excluding dailies
// and index.md.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/cli/commands/init";
import { getCurrentBranch, setAdoptedRef } from "../../src/adopted-ref";
import { resolveRef } from "../../src/git";
import { buildRecents } from "../../src/surface/recents";

function localDateString(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Minimal git helper — disables gpg signing (mirrors changed-paths.test.ts). */
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

let vault: string | null = null;
let entityAAdoptedCommit = "";
let conceptCAdoptedCommit = "";

/**
 * One shared fixture vault:
 *   1. runInit (scaffold commit — files are NOT knowledge pages, won't appear)
 *   2. Commit 1: wiki/entities/a.md (human)
 *   3. Commit 2: wiki/concepts/b.md (human)
 *   4. Commit 3: edit wiki/entities/a.md again (human) — dedup test; a.md is most-recent
 *   5. Commit 4: wiki/dailies/<today>.md + index.md — both EXCLUDED
 *   6. Commit 5: wiki/concepts/c.md with frontmatter `description: "One-line summary"`
 */
async function fixtureVault(): Promise<string> {
  if (vault !== null) return vault;
  vault = mkdtempSync(join(tmpdir(), "dome-recents-vault-"));

  // runInit scaffolds the vault and makes the first commit
  expect(await runInit({ path: vault })).toBe(0);

  // Commit 1: wiki/entities/a.md
  await mkdir(join(vault, "wiki", "entities"), { recursive: true });
  await writeFile(join(vault, "wiki", "entities", "a.md"), "# Entity A\n\nFirst version.\n", "utf8");
  await git(vault, "add", "wiki/entities/a.md");
  await git(vault, "commit", "-qm", "add entity a");

  // Commit 2: wiki/concepts/b.md
  await mkdir(join(vault, "wiki", "concepts"), { recursive: true });
  await writeFile(join(vault, "wiki", "concepts", "b.md"), "# Concept B\n\nA concept.\n", "utf8");
  await git(vault, "add", "wiki/concepts/b.md");
  await git(vault, "commit", "-qm", "add concept b");

  // Commit 3: edit wiki/entities/a.md — this makes a.md the most-recently-changed
  await writeFile(join(vault, "wiki", "entities", "a.md"), "# Entity A\n\nSecond version.\n", "utf8");
  await git(vault, "add", "wiki/entities/a.md");
  await git(vault, "commit", "-qm", "update entity a");
  entityAAdoptedCommit = await resolveRef({ path: vault });

  // Commit 4: wiki/dailies/<today>.md + index.md — both must be EXCLUDED
  const TODAY = localDateString();
  await mkdir(join(vault, "wiki", "dailies"), { recursive: true });
  await writeFile(join(vault, "wiki", "dailies", `${TODAY}.md`), `# ${TODAY}\n`, "utf8");
  await writeFile(join(vault, "index.md"), "# Index\n", "utf8");
  await git(vault, "add", `wiki/dailies/${TODAY}.md`, "index.md");
  await git(vault, "commit", "-qm", "add daily and index");

  // Commit 5: wiki/concepts/c.md with frontmatter description
  await writeFile(
    join(vault, "wiki", "concepts", "c.md"),
    "---\ndescription: \"One-line summary\"\n---\n\n# Concept C\n",
    "utf8",
  );
  await git(vault, "add", "wiki/concepts/c.md");
  await git(vault, "commit", "-qm", "add concept c with description");
  conceptCAdoptedCommit = await resolveRef({ path: vault });

  const branch = await getCurrentBranch(vault);
  if (branch === null) throw new Error("recents fixture unexpectedly detached HEAD");
  const adopted = await setAdoptedRef(vault, branch, conceptCAdoptedCommit);
  if (!adopted.ok) throw new Error(adopted.error.message);

  // This newest HEAD commit is intentionally not adopted. Recents must never
  // expose it or use it to replace the adopted title/change commit.
  await writeFile(join(vault, "wiki", "concepts", "unadopted.md"), "# Unadopted\n", "utf8");
  await writeFile(
    join(vault, "wiki", "concepts", "c.md"),
    "---\ndescription: \"Unadopted title must not leak\"\n---\n\n# Concept C\n",
    "utf8",
  );
  await git(vault, "add", "wiki/concepts/unadopted.md", "wiki/concepts/c.md");
  await git(vault, "commit", "-qm", "unadopted concept must stay hidden");

  return vault;
}

afterAll(async () => {
  if (vault !== null) await rm(vault, { recursive: true, force: true });
});

describe("buildRecents", () => {
  test("dedups to newest change per page, newest-first, over knowledge roots", async () => {
    const v = await fixtureVault();
    const recents = await buildRecents({ vault: v });
    const paths = recents.map((r) => r.path);

    // Commit order (newest first): c.md > daily+index > a.md (edit) > b.md > a.md (create)
    // c.md is the newest knowledge page; a.md dedupes to its edit commit (3rd)
    expect(paths[0]).toBe("wiki/concepts/c.md"); // most-recently changed (commit 5)
    expect(paths).toContain("wiki/entities/a.md");
    expect(paths).toContain("wiki/concepts/b.md");
    expect(paths).not.toContain("index.md");
    expect(paths).not.toContain("wiki/concepts/unadopted.md");
    expect(paths.some((p) => p.startsWith("wiki/dailies/"))).toBe(false);
    expect(paths.filter((p) => p === "wiki/entities/a.md").length).toBe(1); // deduped

    const a = recents.find((r) => r.path === "wiki/entities/a.md")!;
    expect(typeof a.title).toBe("string");
    expect(a.changedBy === "human" || a.changedBy === "engine").toBe(true);
    expect(typeof a.lastChangedAt).toBe("string");
    // Dedup must keep the NEWEST commit (the edit), not the creation commit.
    // Commit 3 has subject "update entity a"; Commit 1 had "add entity a".
    expect(a.subject).toBe("update entity a");
    expect(a.commit).toBe(entityAAdoptedCommit);
    expect(a.commit).toMatch(/^[0-9a-f]{40}$/);
  }, 30_000);

  test("title comes from frontmatter description when present", async () => {
    const v = await fixtureVault();
    const recents = await buildRecents({ vault: v });
    const concept = recents.find((r) => r.path === "wiki/concepts/c.md")!;
    expect(concept.title).toBe("One-line summary");
    expect(concept.commit).toBe(conceptCAdoptedCommit);
  }, 30_000);

  test("respects limit", async () => {
    const v = await fixtureVault();
    expect((await buildRecents({ vault: v, limit: 1 })).length).toBe(1);
  }, 30_000);

  test("returns empty when the current branch has no adopted ref", async () => {
    const v = mkdtempSync(join(tmpdir(), "dome-recents-uninitialized-"));
    try {
      await git(v, "init", "-q", "-b", "main");
      await git(v, "config", "user.name", "Dome Test");
      await git(v, "config", "user.email", "dome@test.invalid");
      await mkdir(join(v, "wiki", "concepts"), { recursive: true });
      await writeFile(join(v, "wiki", "concepts", "head-only.md"), "# Head only\n", "utf8");
      await git(v, "add", ".");
      await git(v, "commit", "-qm", "head only");
      expect(await buildRecents({ vault: v })).toEqual([]);
    } finally {
      await rm(v, { recursive: true, force: true });
    }
  });
});
