// `dome query --miss` / `dome export-context --miss` — CLI wiring tests for
// Task 12's retrieval-miss log. Hermetic: real temp vault (runInit + runSync,
// pattern from tests/cli/commands/today.test.ts), captured console, real git
// commits. The collector itself (`reportMiss`) is unit-tested in
// tests/surface/report-miss.test.ts; this file proves the Commander
// `--miss [note]` optional-value flag reaches it correctly from both
// commands and that the command's own stdout stays untouched.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../../src/cli/commands/init";
import { runSync } from "../../../src/cli/commands/sync";
import { runQuery } from "../../../src/cli/commands/query";
import { runExportContext } from "../../../src/cli/commands/export-context";
import { add, commit, log, readBlob, resolveRef } from "../../../src/git";

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...p: unknown[]) => { logs.push(p.map(String).join(" ")); };
  console.error = (...p: unknown[]) => { errors.push(p.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

let vault: string | null = null;

async function fixtureVault(): Promise<string> {
  if (vault !== null) return vault;
  vault = mkdtempSync(join(tmpdir(), "dome-query-miss-vault-"));
  expect(await runInit({ path: vault })).toBe(0);
  await mkdir(join(vault, "wiki"), { recursive: true });
  await writeFile(
    join(vault, "wiki", "platform.md"),
    "---\ntype: concept\n---\n# Platform\n\nPlatform ownership notes.\n",
    "utf8",
  );
  await add(vault, "wiki/platform.md");
  await commit({ path: vault, message: "seed platform note" });
  expect(await runSync({ vault, quiet: true })).toBe(0);
  return vault;
}

afterAll(async () => {
  if (vault !== null) await rm(vault, { recursive: true, force: true });
});

async function headSha(v: string): Promise<string> {
  return resolveRef({ path: v, ref: "HEAD" });
}

async function missesFileAt(v: string): Promise<string | null> {
  const head = await headSha(v);
  return readBlob({ path: v, commit: head, filepath: "meta/retrieval-misses.md" });
}

describe("dome query --miss", () => {
  test("records the miss after printing results, with the supplied note", async () => {
    const v = await fixtureVault();
    const before = await headSha(v);
    logs = [];
    errors = [];

    const code = await runQuery({
      vault: v,
      text: "platform ownership",
      miss: "packet felt thin",
    });
    expect(code).toBe(0);

    // Query's own stdout is untouched — no miss-related noise on it.
    expect(logs.join("\n")).not.toContain("miss recorded");
    // The acknowledgment goes to console.error (stderr), not stdout.
    expect(errors.join("\n")).toContain("dome query: miss recorded");

    const after = await headSha(v);
    expect(after).not.toBe(before);
    const entries = await log({ path: v, depth: 1 });
    expect(entries[0]!.oid).toBe(after);
    expect(entries[0]!.commit.message.trim()).toBe("miss: platform ownership");
    expect(entries[0]!.commit.message).not.toContain("Dome-Run:");

    const misses = await missesFileAt(v);
    expect(misses).not.toBeNull();
    expect(misses).toMatch(
      /^- \d{4}-\d{2}-\d{2} — "platform ownership" — packet felt thin$/m,
    );
  }, 120_000);

  test("bare --miss (no note) defaults the entry note to 'no note'", async () => {
    const v = await fixtureVault();
    const before = await headSha(v);

    const code = await runQuery({ vault: v, text: "widget rollout", miss: true });
    expect(code).toBe(0);
    expect(await headSha(v)).not.toBe(before);

    const misses = await missesFileAt(v);
    expect(misses).toMatch(/^- \d{4}-\d{2}-\d{2} — "widget rollout" — no note$/m);
  }, 120_000);

  test("omitting --miss records nothing", async () => {
    const v = await fixtureVault();
    const before = await headSha(v);

    const code = await runQuery({ vault: v, text: "no miss flag here" });
    expect(code).toBe(0);
    expect(await headSha(v)).toBe(before);
  }, 120_000);
});

describe("dome export-context --miss", () => {
  test("records the miss after printing the packet, with the supplied note", async () => {
    const v = await fixtureVault();
    const before = await headSha(v);
    logs = [];
    errors = [];

    const code = await runExportContext({
      vault: v,
      topic: "platform ownership",
      miss: "missing the decision history",
    });
    expect(code).toBe(0);
    expect(errors.join("\n")).toContain("dome export-context: miss recorded");

    const after = await headSha(v);
    expect(after).not.toBe(before);
    const entries = await log({ path: v, depth: 1 });
    expect(entries[0]!.commit.message.trim()).toBe("miss: platform ownership");

    const misses = await missesFileAt(v);
    expect(misses).toMatch(
      /^- \d{4}-\d{2}-\d{2} — "platform ownership" — missing the decision history$/m,
    );
  }, 120_000);
});
