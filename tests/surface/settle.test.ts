// surface/settle — tests for `performSettle`, the commit-or-nothing settle
// seam (docs/wiki/specs/task-lifecycle.md §"The settle operation").
//
// Settling is a DECISION, not authoring: `performSettle` locates a task line
// by its move-stable `^block-anchor` across adopted markdown and applies a
// close / defer / keep disposition as one ordinary HUMAN commit (no Dome-*
// trailers) — exactly the trust posture of `performCapture`. The five
// behaviors pinned here:
//
//   - close  → sets `- [x]` on the origin line AND appends a Done-today
//              bullet to today's daily, in ONE commit.
//   - defer  → rewrites the `📅 YYYY-MM-DD` due token to `deferUntil`.
//   - keep   → settles WITHOUT a commit (the tri-state parity option).
//   - unknown blockId → { status: "not-found" }, no commit.
//   - defer without a date → { status: "invalid" }, no commit.
//
// Fixtures run against a real temp vault through real git (never mocks).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CLOSE_END,
  CLOSE_START,
} from "../../assets/extensions/dome.daily/processors/daily-types";
import { runInit } from "../../src/cli/commands/init";
import { commitSingleFileOnHead, log, readBlob, resolveRef } from "../../src/git";
import { performSettle } from "../../src/surface/settle";

// ----- Fixtures -------------------------------------------------------------

let tempDirs: string[] = [];

// `runInit` (the fixture scaffold) prints to the console; keep test output
// pristine by capturing it, exactly as tests/cli/capture.test.ts does.
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
  const vault = tempDir("dome-settle-vault-");
  expect(await runInit({ path: vault })).toBe(0);
  return vault;
}

/** Write `content` to disk AND land it in HEAD as a human commit. */
async function commitFile(
  vault: string,
  relPath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(join(vault, relPath)), { recursive: true });
  await writeFile(join(vault, relPath), content, "utf8");
  await commitSingleFileOnHead({
    path: vault,
    filepath: relPath,
    content,
    message: `fixture: ${relPath}`,
    author: { name: "fixture", email: "fixture@local" },
  });
}

async function headSha(vault: string): Promise<string> {
  return resolveRef({ path: vault, ref: "HEAD" });
}

async function readAt(vault: string, relPath: string): Promise<string> {
  const head = await headSha(vault);
  const content = await readBlob({ path: vault, commit: head, filepath: relPath });
  if (content === null) throw new Error(`no blob at ${relPath}`);
  return content;
}

// A fixed "today" so the daily path (wiki/dailies/{date}.md) is deterministic.
const NOW = new Date(2026, 5, 15, 9, 0, 0); // local 2026-06-15
const TODAY_DAILY = "wiki/dailies/2026-06-15.md";
const clock = { now: () => NOW };

const ANCHOR = "tabc123def456";
const ORIGIN_PATH = "wiki/projects/alpha.md";
const OPEN_TASK_LINE = `- [ ] #task ship the widget 📅 2026-06-01 ^${ANCHOR}`;

function originFile(taskLine: string): string {
  return ["# Alpha Project", "", taskLine, "", "Some prose.", ""].join("\n");
}

function dailyFile(): string {
  return [
    "---",
    "type: daily",
    "created: 2026-06-15",
    "---",
    "",
    "# 2026-06-15",
    "",
    "## Start Here",
    "",
    "## Done",
    "",
    "## Story of the Day",
    "",
  ].join("\n");
}

/**
 * A daily where the evening `dome.daily:close` scaffold has ALREADY rendered
 * — its machine-owned block under `## Done` carries its own `### Done today`
 * heading inside the markers (the exact `closeScaffoldSection` shape). A
 * settle bullet must never land inside it.
 */
function dailyFileWithCloseBlock(): string {
  return [
    "---",
    "type: daily",
    "created: 2026-06-15",
    "---",
    "",
    "# 2026-06-15",
    "",
    "## Start Here",
    "",
    "## Done",
    "",
    CLOSE_START,
    "### Done today",
    "Nothing recorded as settled today.",
    "### Still open",
    "- No loops still open.",
    "### Story of the Day",
    "The story stays yours — write it in the ## Story of the Day section below; the close never generates prose.",
    CLOSE_END,
    "",
    "## Story of the Day",
    "",
  ].join("\n");
}

/** The close-block body (between the markers), for untouched-block asserts. */
function closeBlockSlice(content: string): string {
  const start = content.indexOf(CLOSE_START);
  const end = content.indexOf(CLOSE_END);
  if (start === -1 || end === -1) throw new Error("close block not found");
  return content.slice(start, end + CLOSE_END.length);
}

// ----- close ----------------------------------------------------------------

describe("performSettle — close", () => {
  test("checks the box and appends a Done-today bullet in one commit", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));
    await commitFile(vault, TODAY_DAILY, dailyFile());
    const before = await headSha(vault);

    const result = await performSettle(
      vault,
      { blockId: ANCHOR, disposition: "close" },
      clock,
    );

    expect(result.status).toBe("settled");
    if (result.status !== "settled") throw new Error("unreachable");
    expect(result.blockId).toBe(ANCHOR);
    expect(result.disposition).toBe("close");
    expect(typeof result.commit).toBe("string");
    expect(result.commit).not.toBe(before);

    // Origin line is now completed.
    const origin = await readAt(vault, ORIGIN_PATH);
    expect(origin).toContain(`- [x] #task ship the widget 📅 2026-06-01 ^${ANCHOR}`);
    expect(origin).not.toContain("- [ ] #task ship the widget");

    // Today's daily records the done bullet under ### Done today, one click
    // from the origin line.
    const daily = await readAt(vault, TODAY_DAILY);
    expect(daily).toContain("### Done today");
    expect(daily).toContain(
      `- ship the widget 📅 2026-06-01 ([[wiki/projects/alpha#^${ANCHOR}|from]])`,
    );

    // Exactly one new commit (checkbox + Done-today append together).
    const commits = await log({ path: vault, depth: 2 });
    expect(commits[0]!.oid).toBe(result.commit!);
    expect(commits[0]!.commit.parent[0]!).toBe(before);
  });

  test("never writes inside an already-rendered dome.daily:close block", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));
    await commitFile(vault, TODAY_DAILY, dailyFileWithCloseBlock());
    const fixtureBlock = closeBlockSlice(dailyFileWithCloseBlock());

    const result = await performSettle(
      vault,
      { blockId: ANCHOR, disposition: "close" },
      clock,
    );
    expect(result.status).toBe("settled");

    const daily = await readAt(vault, TODAY_DAILY);
    const bullet = `- ship the widget 📅 2026-06-01 ([[wiki/projects/alpha#^${ANCHOR}|from]])`;

    // The machine-owned block is byte-identical — the bullet did NOT land
    // between CLOSE_START…CLOSE_END (it would become subject to the block's
    // keep/delete semantics and be re-read by previousDailyDigest).
    expect(closeBlockSlice(daily)).toBe(fixtureBlock);

    // The bullet landed under a bare `### Done today` OUTSIDE the markers.
    expect(daily).toContain(bullet);
    const bulletIdx = daily.indexOf(bullet);
    const blockStartIdx = daily.indexOf(CLOSE_START);
    expect(bulletIdx).toBeLessThan(blockStartIdx);
    const bareHeadingIdx = daily.indexOf("### Done today");
    expect(bareHeadingIdx).toBeLessThan(blockStartIdx);
    expect(bareHeadingIdx).toBeLessThan(bulletIdx);

    // Re-run stays idempotent: the line is already settled, so no new commit
    // and no duplicate bullet.
    const afterFirst = await headSha(vault);
    const again = await performSettle(
      vault,
      { blockId: ANCHOR, disposition: "close" },
      clock,
    );
    expect(again.status).toBe("settled");
    expect(await headSha(vault)).toBe(afterFirst);
    expect((await readAt(vault, TODAY_DAILY)).split(bullet).length - 1).toBe(1);
  });
});

// ----- defer ----------------------------------------------------------------

describe("performSettle — defer", () => {
  test("rewrites the 📅 due token to deferUntil, preserving the anchor", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));
    const before = await headSha(vault);

    const result = await performSettle(
      vault,
      { blockId: ANCHOR, disposition: "defer", deferUntil: "2026-07-01" },
      clock,
    );

    expect(result.status).toBe("settled");
    if (result.status !== "settled") throw new Error("unreachable");
    expect(result.disposition).toBe("defer");
    expect(result.commit).not.toBe(before);

    const origin = await readAt(vault, ORIGIN_PATH);
    expect(origin).toContain(`📅 2026-07-01`);
    expect(origin).not.toContain("📅 2026-06-01");
    expect(origin).toContain(`^${ANCHOR}`);
    // Still an open task — defer does not settle the checkbox.
    expect(origin).toContain("- [ ] #task ship the widget");
  });
});

// ----- keep -----------------------------------------------------------------

describe("performSettle — keep", () => {
  test("settles WITHOUT a commit", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));
    const before = await headSha(vault);

    const result = await performSettle(
      vault,
      { blockId: ANCHOR, disposition: "keep" },
      clock,
    );

    expect(result.status).toBe("settled");
    if (result.status !== "settled") throw new Error("unreachable");
    expect(result.disposition).toBe("keep");
    expect(result.commit).toBeUndefined();

    // No commit landed.
    expect(await headSha(vault)).toBe(before);
  });
});

// ----- not-found ------------------------------------------------------------

describe("performSettle — unknown blockId", () => {
  test("returns not-found and lands no commit", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));
    const before = await headSha(vault);

    const result = await performSettle(
      vault,
      { blockId: "tnosuchanchor", disposition: "close" },
      clock,
    );

    expect(result.status).toBe("not-found");
    expect(await headSha(vault)).toBe(before);
  });
});

// ----- invalid --------------------------------------------------------------

describe("performSettle — defer without a date", () => {
  test("returns invalid and lands no commit", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));
    const before = await headSha(vault);

    const result = await performSettle(
      vault,
      { blockId: ANCHOR, disposition: "defer" },
      clock,
    );

    expect(result.status).toBe("invalid");
    expect(await headSha(vault)).toBe(before);
  });
});
