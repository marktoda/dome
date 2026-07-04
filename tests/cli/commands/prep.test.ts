// `dome prep` — CLI wrapper over the dome.daily.prep view. Hermetic: real
// temp vault, real sync, captured console (pattern from
// tests/cli/commands/today.test.ts). Deeper field-level coverage lives in
// tests/harness/scenarios/cli-surface/prep-view.scenario.test.ts.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../../src/cli/commands/init";
import { runPrep } from "../../../src/cli/commands/prep";
import { runSync } from "../../../src/cli/commands/sync";
import { add, commit } from "../../../src/git";

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
  vault = mkdtempSync(join(tmpdir(), "dome-prep-vault-"));
  expect(await runInit({ path: vault })).toBe(0);
  await mkdir(join(vault, "wiki", "dailies"), { recursive: true });
  await writeFile(
    join(vault, "wiki", "dailies", "2026-01-05.md"),
    "# 2026-01-05\n\n- [ ] review the prep packet\n",
    "utf8",
  );
  await add(vault, "wiki/dailies/2026-01-05.md");
  await commit({ path: vault, message: "seed daily" });
  expect(await runSync({ vault, quiet: true })).toBe(0);
  return vault;
}

afterAll(async () => {
  if (vault !== null) await rm(vault, { recursive: true, force: true });
});

describe("dome prep", () => {
  test("renders the planning packet as markdown by default", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runPrep({ vault: v, date: "2026-01-05" })).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("# Dome Prep: 2026-01-05");
    expect(out).toContain("review the prep packet");
    // Human output is not a JSON envelope.
    expect(out.trimStart()).not.toMatch(/^[{[]/);
  }, 120_000);

  test("--json emits the bare dome.daily.prep/v1 payload", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runPrep({ vault: v, date: "2026-01-05", json: true })).toBe(0);
    const doc = JSON.parse(logs.join("\n"));
    expect(doc.schema).toBe("dome.daily.prep/v1");
    expect(doc.date).toBe("2026-01-05");
    expect(typeof doc.markdown).toBe("string");
  }, 120_000);
});
