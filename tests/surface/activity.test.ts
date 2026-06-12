// buildActivityLog — the git-native activity collector behind `dome log`.
// Hermetic: real temp vault, real init + human commit + sync (engine
// commits with Dome-Run trailers exist after sync), runs.db join read-only.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/cli/commands/init";
import { runSync } from "../../src/cli/commands/sync";
import { add, commit } from "../../src/git";
import { buildActivityLog } from "../../src/surface/activity";

function localDateString(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

let vault: string | null = null;

/**
 * One shared fixture: init + a human commit seeding a daily note with an
 * unanchored task + sync. The daily-note task forces deterministic engine
 * patches (block-id stamping et al.), so the history carries both a human
 * commit and Dome-Run-trailered engine commits.
 */
async function fixtureVault(): Promise<string> {
  if (vault !== null) return vault;
  vault = mkdtempSync(join(tmpdir(), "dome-activity-vault-"));
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

describe("buildActivityLog", () => {
  test("joins engine commits to the run ledger and labels human commits", async () => {
    const v = await fixtureVault();
    const entries = await buildActivityLog({ vault: v, limit: 50 });
    expect(entries.length).toBeGreaterThan(0);

    const engine = entries.find((e) => e.author === "engine");
    expect(engine).toBeDefined();
    expect(engine?.runId).toMatch(/^run_/);
    expect(engine?.extensionId).not.toBeNull();
    // The ledger row for that runId exists; the join carries its facts.
    expect(engine?.run).not.toBeNull();
    expect(engine?.run?.status).toBe("succeeded");
    // The narrative body never leaks the Dome-* trailer block.
    expect(engine?.body ?? "").not.toContain("Dome-Run:");

    const human = entries.find((e) => e.author === "human");
    expect(human).toBeDefined();
    expect(human?.runId).toBeNull();
    expect(human?.extensionId).toBeNull();
    expect(human?.run).toBeNull();
  }, 120_000);

  test("entries are newest-first", async () => {
    const v = await fixtureVault();
    const entries = await buildActivityLog({ vault: v, limit: 50 });
    const times = entries.map((e) => new Date(e.when).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]!).toBeGreaterThanOrEqual(times[i]!);
    }
    // The human seed commit predates every engine commit produced by sync.
    const human = entries.find((e) => e.subject === "seed daily");
    expect(human).toBeDefined();
  }, 120_000);

  test("grep narrows on subject and body", async () => {
    const v = await fixtureVault();
    const entries = await buildActivityLog({ vault: v, grep: "seed daily" });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(`${entry.subject}\n${entry.body}`.toLowerCase()).toContain(
        "seed daily",
      );
    }
  }, 120_000);

  test("limit caps the entry count", async () => {
    const v = await fixtureVault();
    const entries = await buildActivityLog({ vault: v, limit: 1 });
    expect(entries.length).toBe(1);
  }, 120_000);

  test("processor filter keeps only matching engine entries", async () => {
    const v = await fixtureVault();
    const all = await buildActivityLog({ vault: v, limit: 50 });
    const engine = all.find((e) => e.author === "engine");
    expect(engine).toBeDefined();
    const extensionId = engine?.extensionId ?? "";

    const filtered = await buildActivityLog({ vault: v, processor: extensionId });
    expect(filtered.length).toBeGreaterThan(0);
    for (const entry of filtered) {
      expect(entry.author).toBe("engine");
      expect(entry.extensionId).toBe(extensionId);
    }

    const none = await buildActivityLog({ vault: v, processor: "no.such.processor" });
    expect(none.length).toBe(0);
  }, 120_000);

  test("since bounds the window", async () => {
    const v = await fixtureVault();
    // 2099, not 2100: git's approxidate parser mishandles years >= 2100
    // (verified against git 2.50.x — `--since=2100-01-01` returns everything).
    const future = await buildActivityLog({ vault: v, since: "2099-01-01" });
    expect(future.length).toBe(0);
    const epoch = await buildActivityLog({ vault: v, since: "1970-01-01" });
    expect(epoch.length).toBeGreaterThan(0);
  }, 120_000);
});
