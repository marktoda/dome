// `dome explain` — the provenance debugger: claim → facts → runs → engine
// commits. Hermetic end-to-end (pattern from today.test.ts): a real temp
// vault (runInit), a committed anchored claim, a real `dome sync` adoption
// pass with the shipped bundles, then assertions over the dome.explain/v1
// document the CLI emits under `--json`.

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimAnchorId } from "../../../assets/extensions/dome.claims/processors/claims-shared";
import { runExplain } from "../../../src/cli/commands/explain";
import { runInit } from "../../../src/cli/commands/init";
import { runSync } from "../../../src/cli/commands/sync";
import { add, commit } from "../../../src/git";

const TEST_TIMEOUT_MS = 120_000;

const CLAIM_PATH = "wiki/launch.md";

// The stamp processor assigns this exact deterministic anchor to the first
// `Status:` claim on the page (occurrence 0), so the test can target it
// without re-reading the stamped file.
const CLAIM_ANCHOR = claimAnchorId({
  path: CLAIM_PATH,
  key: "Status",
  occurrence: 0,
});

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
  vault = mkdtempSync(join(tmpdir(), "dome-explain-vault-"));
  expect(await runInit({ path: vault })).toBe(0);
  await mkdir(join(vault, "wiki"), { recursive: true });
  await writeFile(
    join(vault, CLAIM_PATH),
    "# Launch\n\n**Status:** Shipped *(as of 2026-01-01)*\n",
    "utf8",
  );
  await add(vault, CLAIM_PATH);
  await commit({ path: vault, message: "seed a claim page" });
  // First sync adopts the page and indexes the claim into facts.
  expect(await runSync({ vault, quiet: true })).toBe(0);
  // Garden signal dispatch for a human proposal lags one drift-bearing tick,
  // so a second edit + sync fires dome.claims.stamp: the ^c anchor lands as
  // an engine commit with Dome-* trailers touching the page, and the index
  // re-runs so the claim fact carries the anchor as its sourceRef stableId.
  await appendFile(join(vault, CLAIM_PATH), "\nMore detail.\n");
  await add(vault, CLAIM_PATH);
  await commit({ path: vault, message: "expand the claim page" });
  expect(await runSync({ vault, quiet: true })).toBe(0);
  return vault;
}

afterAll(async () => {
  if (vault !== null) await rm(vault, { recursive: true, force: true });
});

function jsonDoc(): Record<string, unknown> {
  return JSON.parse(logs.join("\n")) as Record<string, unknown>;
}

describe("dome explain", () => {
  test("anchored target --json returns claim + fact provenance + runs + trailered commits", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(
      await runExplain({
        target: `${CLAIM_PATH}#^${CLAIM_ANCHOR}`,
        vault: v,
        json: true,
      }),
    ).toBe(0);

    const doc = jsonDoc();
    expect(doc.schema).toBe("dome.explain/v1");
    expect(doc.path).toBe(CLAIM_PATH);
    expect(doc.anchor).toBe(CLAIM_ANCHOR);

    // The claim, decoded from the adopted-state projection fact.
    const claim = doc.claim as Record<string, unknown>;
    expect(claim.key).toBe("Status");
    expect(claim.value).toContain("Shipped");
    expect(claim.as_of).toBe("2026-01-01");
    expect(claim.anchor).toBe(CLAIM_ANCHOR);
    expect(typeof claim.line).toBe("number");

    // ≥1 fact row with run provenance from the producing indexer.
    const facts = doc.facts as Array<Record<string, unknown>>;
    expect(facts.length).toBeGreaterThan(0);
    const claimFact = facts.find(
      (f) => f.predicate === "dome.claims.claim",
    );
    expect(claimFact).toBeDefined();
    expect(claimFact?.processor_id).toBe("dome.claims.index");
    expect(typeof claimFact?.run_id).toBe("string");

    // The run-ledger join for that fact's run.
    const runs = doc.runs as Array<Record<string, unknown>>;
    expect(runs.length).toBeGreaterThan(0);
    const indexRun = runs.find((r) => r.run_id === claimFact?.run_id);
    expect(indexRun).toBeDefined();
    expect(indexRun?.processor_id).toBe("dome.claims.index");
    expect(indexRun?.status).toBe("succeeded");
    expect(typeof indexRun?.started_at).toBe("string");

    // ≥1 engine commit with Dome-* trailers (the anchor stamp touched the
    // page), newest-first git history bounded to the target path.
    const commits = doc.commits as Array<Record<string, unknown>>;
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.some((c) => c.dome_run !== null)).toBe(true);
    expect(typeof commits[0]?.sha).toBe("string");
    expect(typeof commits[0]?.committed_at).toBe("string");
  }, TEST_TIMEOUT_MS);

  test("path without anchor returns facts + commits with claim null", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(
      await runExplain({ target: CLAIM_PATH, vault: v, json: true }),
    ).toBe(0);

    const doc = jsonDoc();
    expect(doc.schema).toBe("dome.explain/v1");
    expect(doc.claim).toBeNull();
    expect(doc.anchor).toBeNull();
    expect((doc.facts as unknown[]).length).toBeGreaterThan(0);
    expect((doc.commits as unknown[]).length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  test("nonexistent adopted path is a command error, exit 64", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(
      await runExplain({ target: "wiki/nope.md", vault: v, json: true }),
    ).toBe(64);
    const doc = jsonDoc();
    expect(doc.schema).toBe("dome.command-error/v1");
    expect(doc.status).toBe("error");
    expect(doc.command).toBe("explain");
  }, TEST_TIMEOUT_MS);

  test("nonexistent path without --json errors on stderr, exit 64", async () => {
    const v = await fixtureVault();
    expect(await runExplain({ target: "wiki/nope.md", vault: v })).toBe(64);
    expect(errors.join("\n")).toContain("wiki/nope.md");
  }, TEST_TIMEOUT_MS);

  test("human output renders the chain: claim, facts, runs, commits", async () => {
    const v = await fixtureVault();
    logs = [];
    expect(
      await runExplain({
        target: `${CLAIM_PATH}#^${CLAIM_ANCHOR}`,
        vault: v,
      }),
    ).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("Status");
    expect(out).toContain("Shipped");
    expect(out).toContain("dome.claims.index");
    expect(out).toContain("Runs");
    expect(out).toContain("commits");
  }, TEST_TIMEOUT_MS);
});
