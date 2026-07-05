// surface/report-miss — tests for `reportMiss`, the retrieval-miss log
// collector (Task 12; docs/wiki/specs/preferences.md-style append-only
// convention, applied to `meta/retrieval-misses.md`).
//
// This is the evidence base the memory plan gated retrieval-quality work
// (banked embeddings) on: it was never operationalized because agents were
// asked to "note the miss" with no mechanical channel. `reportMiss` is that
// channel — mirrors `performCapture` / `performSettle`: an ordinary HUMAN
// commit (no Dome-* trailers), never talks to the engine.
//
// Task 11's report card counts entries via
// `assets/extensions/dome.health/processors/report-card-render.ts`'s
// `countRetrievalMisses`, which matches the grammar
// `^- (\d{4}-\d{2}-\d{2}) —`. This file's grammar-exactness tests import that
// counter directly so a drift between collector and counter fails here, not
// silently in production.
//
// Fixtures run against a real temp vault through real git (never mocks).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countRetrievalMisses } from "../../assets/extensions/dome.health/processors/report-card-render";
import { runInit } from "../../src/cli/commands/init";
import { log, readBlob, resolveRef } from "../../src/git";
import {
  RETRIEVAL_MISSES_PATH,
  reportMiss,
  reportMissFromCliFlag,
} from "../../src/surface/report-miss";

// ----- Fixtures -------------------------------------------------------------

let tempDirs: string[] = [];

// `runInit` prints to the console; keep test output pristine, exactly as
// tests/surface/settle.test.ts does.
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
});

afterEach(async () => {
  console.log = origLog;
  console.error = origErr;
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initVault(): Promise<string> {
  const vault = tempDir("dome-report-miss-vault-");
  expect(await runInit({ path: vault })).toBe(0);
  return vault;
}

async function headSha(vault: string): Promise<string> {
  return resolveRef({ path: vault, ref: "HEAD" });
}

async function readAt(vault: string, relPath: string): Promise<string | null> {
  const head = await headSha(vault);
  return readBlob({ path: vault, commit: head, filepath: relPath });
}

const NOW = new Date(2026, 5, 15, 9, 0, 0); // local 2026-06-15
const clock = { now: () => NOW };

// ----- first miss -------------------------------------------------------------

describe("reportMiss — first miss", () => {
  test("creates the file with a header and the exact grammar entry, and commits", async () => {
    const vault = await initVault();
    const before = await headSha(vault);

    const result = await reportMiss(
      vault,
      { query: "platform ownership", note: "no hit on the daily surface" },
      clock,
    );

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") throw new Error("unreachable");
    expect(typeof result.commit).toBe("string");
    expect(result.commit).not.toBe(before);

    const content = await readAt(vault, RETRIEVAL_MISSES_PATH);
    expect(content).not.toBeNull();
    expect(content).toContain("# Retrieval misses");
    expect(content).toContain(
      '- 2026-06-15 — "platform ownership" — no hit on the daily surface',
    );

    // Exactly one new commit, human-authored (no Dome-* trailer).
    const commits = await log({ path: vault, depth: 2 });
    expect(commits[0]!.oid).toBe(result.commit);
    expect(commits[0]!.commit.parent[0]!).toBe(before);
    expect(commits[0]!.commit.message).toContain(
      "miss: platform ownership",
    );
    expect(commits[0]!.commit.message).not.toContain("Dome-Run:");
  });

  test("note defaults to 'no note' when omitted", async () => {
    const vault = await initVault();

    const result = await reportMiss(vault, { query: "widget rollout" }, clock);
    expect(result.status).toBe("recorded");

    const content = await readAt(vault, RETRIEVAL_MISSES_PATH);
    expect(content).toContain('- 2026-06-15 — "widget rollout" — no note');
  });

  test("commit message truncates the query to its first 40 chars", async () => {
    const vault = await initVault();
    const longQuery =
      "this is a genuinely very long query text that exceeds forty characters easily";

    const result = await reportMiss(vault, { query: longQuery }, clock);
    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") throw new Error("unreachable");

    const commits = await log({ path: vault, depth: 1 });
    expect(commits[0]!.oid).toBe(result.commit);
    expect(commits[0]!.commit.message.startsWith("miss: ")).toBe(true);
    const subject = commits[0]!.commit.message.split("\n")[0]!;
    expect(subject).toBe(`miss: ${longQuery.slice(0, 40)}`);
  });
});

// ----- subsequent misses -------------------------------------------------------

describe("reportMiss — subsequent misses", () => {
  test("appends without duplicating the header, one commit per miss", async () => {
    const vault = await initVault();

    const first = await reportMiss(vault, { query: "first query" }, clock);
    expect(first.status).toBe("recorded");
    const afterFirst = await headSha(vault);

    const second = await reportMiss(
      vault,
      { query: "second query", note: "still missing" },
      clock,
    );
    expect(second.status).toBe("recorded");
    if (second.status !== "recorded") throw new Error("unreachable");
    expect(second.commit).not.toBe(afterFirst);

    const content = await readAt(vault, RETRIEVAL_MISSES_PATH);
    expect(content).not.toBeNull();
    // Header appears exactly once.
    expect(content!.split("# Retrieval misses").length - 1).toBe(1);
    expect(content).toContain('- 2026-06-15 — "first query" — no note');
    expect(content).toContain(
      '- 2026-06-15 — "second query" — still missing',
    );

    // Two commits landed on top of init, one per miss.
    const commits = await log({ path: vault, depth: 3 });
    expect(commits[0]!.oid).toBe(second.commit);
    expect(commits[0]!.commit.parent[0]!).toBe(afterFirst);
  });
});

// ----- grammar exactness (Task 11's counter) -----------------------------------

describe("reportMiss — grammar exactness", () => {
  test("the report-card counter counts every entry reportMiss writes", async () => {
    const vault = await initVault();
    const dates = [
      new Date(2026, 5, 10, 9, 0, 0),
      new Date(2026, 5, 11, 9, 0, 0),
      new Date(2026, 5, 12, 9, 0, 0),
    ];
    for (const d of dates) {
      const outcome = await reportMiss(
        vault,
        { query: `query for ${d.getDate()}`, note: "missing context" },
        { now: () => d },
      );
      expect(outcome.status).toBe("recorded");
    }

    const content = await readAt(vault, RETRIEVAL_MISSES_PATH);
    expect(content).not.toBeNull();

    const windowDates = new Set(["2026-06-10", "2026-06-11", "2026-06-12"]);
    expect(countRetrievalMisses(content!, windowDates)).toBe(3);

    // A window that excludes all three dates counts zero — proves the counter
    // is reading OUR date field, not just counting lines.
    expect(countRetrievalMisses(content!, new Set(["2099-01-01"]))).toBe(0);
  });

  test("query/note text containing an em dash does not confuse the counter", async () => {
    const vault = await initVault();
    const outcome = await reportMiss(
      vault,
      { query: "alpha — beta rollout", note: "missing — still" },
      clock,
    );
    expect(outcome.status).toBe("recorded");

    const content = await readAt(vault, RETRIEVAL_MISSES_PATH);
    expect(countRetrievalMisses(content!, new Set(["2026-06-15"]))).toBe(1);
  });
});

// ----- validation / vault preconditions ----------------------------------------

describe("reportMiss — invalid input", () => {
  test("empty query is invalid and lands no commit", async () => {
    const vault = await initVault();
    const before = await headSha(vault);

    const result = await reportMiss(vault, { query: "   " }, clock);
    expect(result.status).toBe("invalid");
    expect(await headSha(vault)).toBe(before);
  });

  test("non-vault path is invalid and lands no commit", async () => {
    const notAVault = tempDir("dome-report-miss-not-a-vault-");

    const result = await reportMiss(notAVault, { query: "anything" }, clock);
    expect(result.status).toBe("invalid");
  });
});

// ----- reportMissFromCliFlag (the optional-value flag seam) --------------------

describe("reportMissFromCliFlag", () => {
  test("undefined flag records nothing", async () => {
    const vault = await initVault();
    const before = await headSha(vault);

    const outcome = await reportMissFromCliFlag({
      vault,
      query: "some query",
      flag: undefined,
    });
    expect(outcome).toBeNull();
    expect(await headSha(vault)).toBe(before);
  });

  test("bare flag (true) records with the default note", async () => {
    const vault = await initVault();

    const outcome = await reportMissFromCliFlag({
      vault,
      query: "some query",
      flag: true,
    });
    expect(outcome?.status).toBe("recorded");

    const content = await readAt(vault, RETRIEVAL_MISSES_PATH);
    expect(content).toContain('"some query" — no note');
  });

  test("flag with a string value records with that note", async () => {
    const vault = await initVault();

    const outcome = await reportMissFromCliFlag({
      vault,
      query: "some query",
      flag: "the specific gap",
    });
    expect(outcome?.status).toBe("recorded");

    const content = await readAt(vault, RETRIEVAL_MISSES_PATH);
    expect(content).toContain('"some query" — the specific gap');
  });

  test("flag === false records nothing (Commander's negatable-flag shape)", async () => {
    const vault = await initVault();
    const before = await headSha(vault);

    const outcome = await reportMissFromCliFlag({
      vault,
      query: "some query",
      flag: false,
    });
    expect(outcome).toBeNull();
    expect(await headSha(vault)).toBe(before);
  });
});
