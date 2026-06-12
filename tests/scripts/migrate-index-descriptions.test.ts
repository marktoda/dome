import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import matter from "gray-matter";

import { migrateIndexDescriptions } from "../../scripts/migrate-index-descriptions";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const MIGRATE_SCRIPT = join(REPO_ROOT, "scripts", "migrate-index-descriptions.ts");

const fixtures: string[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const path = fixtures.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "dome-migrate-index-"));
  fixtures.push(dir);
  mkdirSync(join(dir, "wiki", "entities"), { recursive: true });
  return dir;
}

const BARE_BODY = "# 0age\n\nProtocol engineer notes.\n";
const DESCRIBED_PAGE = [
  "---",
  "description: Already documented elsewhere",
  "---",
  "# hayden",
  "",
  "Existing page.",
  "",
].join("\n");

function writeThreeEntryFixture(dir: string): void {
  writeFileSync(
    join(dir, "index.md"),
    [
      "# Index",
      "",
      "## Entities",
      "",
      "- [[wiki/entities/0age]] — Protocol engineer at Uniswap Labs, leads research",
      "- [[wiki/entities/hayden]] — Founder of Uniswap",
      "- [[wiki/entities/ghost]] — This page does not exist",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "wiki", "entities", "0age.md"), BARE_BODY);
  writeFileSync(join(dir, "wiki", "entities", "hayden.md"), DESCRIBED_PAGE);
}

describe("migrateIndexDescriptions", () => {
  test("updates missing descriptions, skips described pages, reports unmatched", () => {
    const dir = makeVault();
    writeThreeEntryFixture(dir);

    const summary = migrateIndexDescriptions(dir, { dryRun: false });

    expect(summary.updated).toEqual(["wiki/entities/0age.md"]);
    expect(summary.skipped).toEqual(["wiki/entities/hayden.md"]);
    expect(summary.unmatched).toEqual(["wiki/entities/ghost.md"]);

    const migrated = readFileSync(join(dir, "wiki", "entities", "0age.md"), "utf8");
    const parsed = matter(migrated);
    expect(parsed.data.description).toBe(
      "Protocol engineer at Uniswap Labs, leads research",
    );
    // Body bytes are preserved exactly; only a frontmatter block was added.
    expect(parsed.content).toBe(BARE_BODY);

    // Already-described page is byte-for-byte untouched.
    expect(readFileSync(join(dir, "wiki", "entities", "hayden.md"), "utf8")).toBe(
      DESCRIBED_PAGE,
    );
  });

  test("preserves body bytes and existing frontmatter keys when inserting", () => {
    const dir = makeVault();
    const body = "# page\n\ncontent line\n\ntrailing\n";
    writeFileSync(
      join(dir, "wiki", "entities", "keyed.md"),
      `---\nstatus: active\n---\n${body}`,
    );
    writeFileSync(
      join(dir, "index.md"),
      "- [[wiki/entities/keyed]] — Keeps its other keys\n",
    );

    const summary = migrateIndexDescriptions(dir, { dryRun: false });
    expect(summary.updated).toEqual(["wiki/entities/keyed.md"]);

    const parsed = matter(
      readFileSync(join(dir, "wiki", "entities", "keyed.md"), "utf8"),
    );
    expect(parsed.data.status).toBe("active");
    expect(parsed.data.description).toBe("Keeps its other keys");
    expect(parsed.content).toBe(body);
  });

  test("dry-run reports the same summary but changes nothing", () => {
    const dir = makeVault();
    writeThreeEntryFixture(dir);
    const before = readFileSync(join(dir, "wiki", "entities", "0age.md"), "utf8");

    const summary = migrateIndexDescriptions(dir, { dryRun: true });

    expect(summary.updated).toEqual(["wiki/entities/0age.md"]);
    expect(summary.skipped).toEqual(["wiki/entities/hayden.md"]);
    expect(summary.unmatched).toEqual(["wiki/entities/ghost.md"]);
    expect(readFileSync(join(dir, "wiki", "entities", "0age.md"), "utf8")).toBe(
      before,
    );
  });

  test("silently skips non-entry lines (headings, prose, blanks)", () => {
    const dir = makeVault();
    writeFileSync(join(dir, "wiki", "entities", "0age.md"), BARE_BODY);
    writeFileSync(
      join(dir, "index.md"),
      [
        "# My Vault",
        "",
        "Some prose about the vault.",
        "",
        "## Entities",
        "",
        "- plain list item without a wikilink",
        "- [[wiki/entities/0age]] — Protocol engineer",
        "",
        "> a quote",
        "",
      ].join("\n"),
    );

    const summary = migrateIndexDescriptions(dir, { dryRun: false });
    expect(summary.updated).toEqual(["wiki/entities/0age.md"]);
    expect(summary.skipped).toEqual([]);
    expect(summary.unmatched).toEqual([]);
  });

  test("description containing a colon survives the YAML round-trip", () => {
    const dir = makeVault();
    writeFileSync(join(dir, "wiki", "entities", "0age.md"), BARE_BODY);
    const description = "Protocol engineer: leads research, ships v4 hooks";
    writeFileSync(
      join(dir, "index.md"),
      `- [[wiki/entities/0age]] — ${description}\n`,
    );

    migrateIndexDescriptions(dir, { dryRun: false });

    const parsed = matter(
      readFileSync(join(dir, "wiki", "entities", "0age.md"), "utf8"),
    );
    expect(parsed.data.description).toBe(description);
  });

  test("insertion preserves every other byte — bare YAML dates stay bare", () => {
    const dir = makeVault();
    const original = [
      "---",
      "created: 2026-04-06",
      'title: "quoted title"',
      "---",
      "# dated",
      "",
      "Body stays put.",
      "",
    ].join("\n");
    writeFileSync(join(dir, "wiki", "entities", "dated.md"), original);
    writeFileSync(
      join(dir, "index.md"),
      "- [[wiki/entities/dated]] — Holds a bare date\n",
    );

    const summary = migrateIndexDescriptions(dir, { dryRun: false });
    expect(summary.updated).toEqual(["wiki/entities/dated.md"]);

    // Byte-exact: the original file with exactly one line spliced in before
    // the closing fence. No date re-serialization, no quote flips.
    const expected = [
      "---",
      "created: 2026-04-06",
      'title: "quoted title"',
      "description: Holds a bare date",
      "---",
      "# dated",
      "",
      "Body stays put.",
      "",
    ].join("\n");
    expect(readFileSync(join(dir, "wiki", "entities", "dated.md"), "utf8")).toBe(
      expected,
    );
  });

  test("entries resolving outside the vault go to unmatched, untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "dome-migrate-outside-"));
    fixtures.push(root);
    const dir = join(root, "vault");
    mkdirSync(dir, { recursive: true });
    const outside = join(root, "outside.md");
    writeFileSync(outside, BARE_BODY);
    writeFileSync(join(dir, "index.md"), "- [[../outside]] — Escapes the vault\n");

    const summary = migrateIndexDescriptions(dir, { dryRun: false });
    expect(summary.updated).toEqual([]);
    expect(summary.skipped).toEqual([]);
    expect(summary.unmatched).toEqual(["../outside.md"]);
    expect(readFileSync(outside, "utf8")).toBe(BARE_BODY);
  });

  test("duplicate targets: first wins, exact repeat skips, divergent repeat goes unmatched", () => {
    const dir = makeVault();
    writeFileSync(join(dir, "wiki", "entities", "0age.md"), BARE_BODY);
    writeFileSync(
      join(dir, "index.md"),
      [
        "- [[wiki/entities/0age]] — First description",
        "- [[wiki/entities/0age]] — First description",
        "- [[wiki/entities/0age]] — A different description",
        "",
      ].join("\n"),
    );

    // Dry run and real run must report identically.
    const dry = migrateIndexDescriptions(dir, { dryRun: true });
    const real = migrateIndexDescriptions(dir, { dryRun: false });
    expect(dry).toEqual(real);

    expect(real.updated).toEqual(["wiki/entities/0age.md"]);
    expect(real.skipped).toEqual(["wiki/entities/0age.md"]);
    expect(real.unmatched).toEqual(["wiki/entities/0age.md"]);

    const parsed = matter(
      readFileSync(join(dir, "wiki", "entities", "0age.md"), "utf8"),
    );
    expect(parsed.data.description).toBe("First description");
  });

  test("targets that already carry .md resolve without doubling the extension", () => {
    const dir = makeVault();
    writeFileSync(join(dir, "wiki", "entities", "0age.md"), BARE_BODY);
    writeFileSync(
      join(dir, "index.md"),
      "- [[wiki/entities/0age.md]] — Explicit extension entry\n",
    );

    const summary = migrateIndexDescriptions(dir, { dryRun: false });
    expect(summary.updated).toEqual(["wiki/entities/0age.md"]);
  });
});

describe("migrate-index-descriptions CLI", () => {
  test("dry-run prints a summary and writes nothing", async () => {
    const dir = makeVault();
    writeThreeEntryFixture(dir);
    const before = readFileSync(join(dir, "wiki", "entities", "0age.md"), "utf8");

    const proc = Bun.spawn(["bun", MIGRATE_SCRIPT, dir, "--dry-run"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("updated: 1");
    expect(stdout).toContain("skipped: 1");
    expect(stdout).toContain("unmatched: 1");
    expect(stdout).toContain("dry run");
    expect(readFileSync(join(dir, "wiki", "entities", "0age.md"), "utf8")).toBe(
      before,
    );
  });

  test("fails with usage when no vault path is given", async () => {
    const proc = Bun.spawn(["bun", MIGRATE_SCRIPT], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage");
  });
});
