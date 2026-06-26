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
    expect(paths.some((p) => p.startsWith("wiki/dailies/"))).toBe(false);
    expect(paths.filter((p) => p === "wiki/entities/a.md").length).toBe(1); // deduped

    const a = recents.find((r) => r.path === "wiki/entities/a.md")!;
    expect(typeof a.title).toBe("string");
    expect(a.changedBy === "human" || a.changedBy === "engine").toBe(true);
    expect(typeof a.lastChangedAt).toBe("string");
    // Dedup must keep the NEWEST commit (the edit), not the creation commit.
    // Commit 3 has subject "update entity a"; Commit 1 had "add entity a".
    expect(a.subject).toBe("update entity a");
  }, 30_000);

  test("title comes from frontmatter description when present", async () => {
    const v = await fixtureVault();
    const recents = await buildRecents({ vault: v });
    expect(recents.find((r) => r.path === "wiki/concepts/c.md")!.title).toBe("One-line summary");
  }, 30_000);

  test("respects limit", async () => {
    const v = await fixtureVault();
    expect((await buildRecents({ vault: v, limit: 1 })).length).toBe(1);
  }, 30_000);
});
