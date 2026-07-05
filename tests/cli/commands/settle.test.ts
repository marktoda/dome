// `dome settle` — end-to-end tests for the CLI binding over `performSettle`
// (src/surface/settle.ts). Unlike `dome resolve` (projection-db backed),
// settle is a fs/git-direct commit-or-nothing write — same trust domain as
// `dome capture` — so the fixture mirrors tests/cli/capture.test.ts and
// tests/surface/settle.test.ts rather than ./fixture.ts's projection setup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runInit } from "../../../src/cli/commands/init";
import { runSettle } from "../../../src/cli/commands/settle";
import { commitSingleFileOnHead, resolveRef } from "../../../src/git";

// ----- Console capture -------------------------------------------------------

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map((p) => String(p)).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    errors.push(parts.map((p) => String(p)).join(" "));
  };
});

let tempDirs: string[] = [];

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
  const vault = tempDir("dome-settle-cli-vault-");
  expect(await runInit({ path: vault })).toBe(0);
  logs = [];
  errors = [];
  return vault;
}

async function commitFile(vault: string, relPath: string, content: string): Promise<void> {
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

const NOW = new Date(2026, 5, 15, 9, 0, 0); // local 2026-06-15
const clock = { now: () => NOW };

const ANCHOR = "tabc123def456";
const ORIGIN_PATH = "wiki/projects/alpha.md";
const OPEN_TASK_LINE = `- [ ] #task ship the widget 📅 2026-06-01 ^${ANCHOR}`;

function originFile(taskLine: string): string {
  return ["# Alpha Project", "", taskLine, "", "Some prose.", ""].join("\n");
}

// ----- runSettle: close ------------------------------------------------------

describe("runSettle close", () => {
  test("closes the task, commits, exits 0, and prints one line", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));
    const before = await headSha(vault);

    const code = await runSettle({ blockId: ANCHOR, disposition: "close", vault }, clock);
    expect(code).toBe(0);
    expect(await headSha(vault)).not.toBe(before);

    expect(errors).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("dome settle: close");
    expect(logs[0]).toContain(`^${ANCHOR}`);
  });

  test("--json emits the dome.settle/v1 payload", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));

    const code = await runSettle(
      { blockId: ANCHOR, disposition: "close", vault, json: true },
      clock,
    );
    expect(code).toBe(0);
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.schema).toBe("dome.settle/v1");
    expect(payload.status).toBe("settled");
    expect(payload.block_id).toBe(ANCHOR);
    expect(payload.disposition).toBe("close");
    expect(typeof payload.commit).toBe("string");
  });
});

// ----- runSettle: defer ------------------------------------------------------

describe("runSettle defer", () => {
  test("--until rewrites the due date and exits 0", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));

    const code = await runSettle(
      { blockId: ANCHOR, disposition: "defer", until: "2026-07-01", vault },
      clock,
    );
    expect(code).toBe(0);
    expect(logs[0]).toContain("dome settle: defer");
  });

  test("defer without --until is invalid and exits 64", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));
    const before = await headSha(vault);

    const code = await runSettle({ blockId: ANCHOR, disposition: "defer", vault }, clock);
    expect(code).toBe(64);
    expect(errors.join("\n")).toContain("dome settle:");
    expect(await headSha(vault)).toBe(before);
  });
});

// ----- runSettle: keep -------------------------------------------------------

describe("runSettle keep", () => {
  test("keep settles without a commit and exits 0", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));
    const before = await headSha(vault);

    const code = await runSettle({ blockId: ANCHOR, disposition: "keep", vault }, clock);
    expect(code).toBe(0);
    expect(await headSha(vault)).toBe(before);
    expect(logs[0]).toContain("dome settle: keep");
  });
});

// ----- runSettle: errors ------------------------------------------------------

describe("runSettle errors", () => {
  test("unknown blockId is not-found and exits 64", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));

    const code = await runSettle(
      { blockId: "tnosuchanchor", disposition: "close", vault },
      clock,
    );
    expect(code).toBe(64);
    expect(errors.join("\n")).toContain("dome settle:");
  });

  test("an unknown disposition is invalid and exits 64", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));

    const code = await runSettle(
      { blockId: ANCHOR, disposition: "delete", vault },
      clock,
    );
    expect(code).toBe(64);
  });

  test("error cases emit the dome.settle/v1 error payload under --json", async () => {
    const vault = await initVault();
    await commitFile(vault, ORIGIN_PATH, originFile(OPEN_TASK_LINE));

    const code = await runSettle(
      { blockId: "tnosuchanchor", disposition: "close", vault, json: true },
      clock,
    );
    expect(code).toBe(64);
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.schema).toBe("dome.settle/v1");
    expect(payload.status).toBe("not-found");
    expect(typeof payload.message).toBe("string");
  });
});
