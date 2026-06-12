// `dome log` — CLI wrapper over the git-native activity collector.
// Hermetic: real temp vault, real sync, captured console (pattern from
// tests/cli/commands/today.test.ts).

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../../src/cli/commands/init";
import { runLog } from "../../../src/cli/commands/log";
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

function localDateString(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

let vault: string | null = null;

async function fixtureVault(): Promise<string> {
  if (vault !== null) return vault;
  vault = mkdtempSync(join(tmpdir(), "dome-log-vault-"));
  expect(await runInit({ path: vault })).toBe(0);
  const TODAY = localDateString();
  await mkdir(join(vault, "wiki", "dailies"), { recursive: true });
  await writeFile(
    join(vault, "wiki", "dailies", `${TODAY}.md`),
    `# ${TODAY}\n\n## Tasks\n\n- [ ] review the activity log plan\n`,
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

type LogDocument = {
  readonly schema: string;
  readonly entries: ReadonlyArray<{
    readonly sha: string;
    readonly author: string;
    readonly subject: string;
    readonly runId: string | null;
  }>;
};

describe("dome log", () => {
  test("renders engine and human activity", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runLog({ vault: v })).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("engine(applyPatch)");
    expect(out).toContain("seed daily");
  }, 120_000);

  test("--json emits the dome.log/v1 document", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runLog({ vault: v, json: true })).toBe(0);
    const doc = JSON.parse(logs.join("\n")) as LogDocument;
    expect(doc.schema).toBe("dome.log/v1");
    expect(doc.entries.length).toBeGreaterThan(0);
    const engine = doc.entries.find((e) => e.author === "engine");
    expect(engine?.runId).toMatch(/^run_/);
  }, 120_000);

  test("--grep narrows the entries", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runLog({ vault: v, grep: "seed daily", json: true })).toBe(0);
    const doc = JSON.parse(logs.join("\n")) as LogDocument;
    expect(doc.entries.length).toBeGreaterThan(0);
    for (const entry of doc.entries) {
      expect(entry.author).toBe("human");
    }
  }, 120_000);

  test("--limit 1 yields a single entry", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(await runLog({ vault: v, limit: 1, json: true })).toBe(0);
    const doc = JSON.parse(logs.join("\n")) as LogDocument;
    expect(doc.entries.length).toBe(1);
  }, 120_000);

  test("a non-repo vault fails with exit 1", async () => {
    const notAVault = mkdtempSync(join(tmpdir(), "dome-log-notavault-"));
    try {
      expect(await runLog({ vault: notAVault })).toBe(1);
      expect(errors.join("\n")).toContain("dome log");
    } finally {
      await rm(notAVault, { recursive: true, force: true });
    }
  }, 120_000);
});
