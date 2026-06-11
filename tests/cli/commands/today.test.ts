// `dome today` — CLI wrapper over the dome.daily.today view. Hermetic:
// real temp vault, real sync, captured console (pattern from tests/http).

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../../src/cli/commands/init";
import { runSync } from "../../../src/cli/commands/sync";
import { runToday } from "../../../src/cli/commands/today";
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

function localDateString(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

let vault: string | null = null;

async function fixtureVault(): Promise<string> {
  if (vault !== null) return vault;
  vault = mkdtempSync(join(tmpdir(), "dome-today-vault-"));
  expect(await runInit({ path: vault })).toBe(0);
  const TODAY = localDateString();
  await mkdir(join(vault, "wiki", "dailies"), { recursive: true });
  await writeFile(
    join(vault, "wiki", "dailies", `${TODAY}.md`),
    `# ${TODAY}\n\n## Tasks\n\n- [ ] review the cockpit plan\n`,
    "utf8",
  );
  await add(vault, `wiki/dailies/${TODAY}.md`);
  await commit({ path: vault, message: "seed daily" });
  expect(await runSync({ vault, quiet: true })).toBe(0);
  return vault;
}

afterAll(async () => {
  if (vault !== null) await rm(vault, { recursive: true, force: true });
});

describe("dome today", () => {
  test("renders the open-task surface", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runToday({ vault: v })).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("review the cockpit plan");
  }, 120_000);

  test("--json emits the dome.daily.today/v1 document", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runToday({ vault: v, json: true })).toBe(0);
    const doc = JSON.parse(logs.join("\n"));
    expect(doc.schema).toBe("dome.daily.today/v1");
    expect(Array.isArray(doc.openTasks)).toBe(true);
  }, 120_000);

  test("--watch with --json is a usage error", async () => {
    expect(await runToday({ vault: await fixtureVault(), json: true, watch: true })).toBe(64);
  }, 120_000);
});
