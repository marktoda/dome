import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ROOT_TEST_SHUTDOWN_GRACE_MS,
  spawnRootTestProcess,
  superviseRootTestChild,
} from "../../scripts/test-root";
import {
  DOGFOOD_SNAPSHOT_PROCESS_BUDGET_MS,
} from "../../scripts/v1-dogfood-snapshot";
import { runSync } from "../../src/cli/commands/sync";
import { commit } from "../../src/git";
import { discoverInitProduct } from "../../src/setup/init-product";
import { adaptVault } from "../../src/setup/vault-adaptation";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SNAPSHOT_SCRIPT = join(REPO_ROOT, "scripts", "v1-dogfood-snapshot.ts");
const SNAPSHOT_PROCESS_TIMEOUT_MS =
  DOGFOOD_SNAPSHOT_PROCESS_BUDGET_MS + ROOT_TEST_SHUTDOWN_GRACE_MS;
const SCENARIO_TIMEOUT_MS = 120_000;

const fixtures: string[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const path = fixtures.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

describe("v1 dogfood snapshot script", () => {
  test("help describes the M10 ledger helper", async () => {
    const result = await runSnapshot(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Emits a read-only Markdown snapshot for the M10 work-vault dogfood ledger.",
    );
  });

  test("emits a dated ledger-ready Markdown snapshot from real CLI surfaces", async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "dome-v1-dogfood-"));
    fixtures.push(vaultPath);

    const initialized = await adaptVault(
      { mode: "compatibility-init", targetPath: vaultPath },
      { discoverProduct: discoverInitProduct },
    );
    expect(initialized.mode).toBe("compatibility-init");
    if (initialized.mode !== "compatibility-init") {
      throw new Error("fixture initialization returned an invalid adaptation mode");
    }
    expect(initialized.result.status).toBe("completed");
    mkdirSync(join(vaultPath, "notes"), { recursive: true });
    writeFileSync(
      join(vaultPath, "notes", "broken-link.md"),
      "# Broken link\n\nSee [[missing thing]] for follow-up.\n",
    );
    await commit({
      path: vaultPath,
      files: ["notes/broken-link.md"],
      message: "add broken link",
    });
    expect(await runSync({ vault: vaultPath, quiet: true })).toBe(0);

    const result = await runSnapshot([
      "--vault",
      vaultPath,
      "--date",
      "2026-06-02",
      "--topic",
      "today open loops",
      "--limit",
      "3",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("## 2026-06-02 Dogfood Snapshot");
    expect(result.stdout).toContain("Commands run:");
    expect(result.stdout).not.toContain("bin/dome today");
    expect(result.stdout).toContain(
      `bin/dome query --vault ${vaultPath} "today open loops" --limit 3 --json`,
    );
    expect(result.stdout).toContain("Operational state:");
    expect(result.stdout).toContain("- Serve host: off");
    expect(result.stdout).toContain("Maintenance loops:");
    expect(result.stdout).toContain("diagnostics ");
    expect(result.stdout).toContain("agent-safe");
    expect(result.stdout).toContain("problem runs");
    expect(result.stdout).toContain("last success");
    expect(result.stdout).toContain("  - processors:");
    expect(result.stdout).toContain("  - surfaces:");
    expect(result.stdout).toContain("  - no-op:");
    expect(result.stdout).toContain("Content hygiene:");
    expect(result.stdout).toContain("- Example findings:");
    expect(result.stdout).toContain("Wikilink [[missing thing]]");
    expect(result.stdout).toContain("Work surface:");
    expect(result.stdout).toContain("Context packet: `today open loops`");
    expect(result.stdout).toContain("Qualitative notes to fill after the work session:");
    expect(result.stdout).toContain(
      "- Lost or overwritten human markdown edits:",
    );
    expect(result.stdout).toContain("- Manual .dome/state edits:");
    expect(result.stdout).toContain(
      "M10 status: this snapshot is supporting evidence only",
    );
  }, { timeout: SCENARIO_TIMEOUT_MS });
});

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runSnapshot(args: ReadonlyArray<string>): Promise<ProcessResult> {
  const proc = spawnRootTestProcess([process.execPath, SNAPSHOT_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, outcome] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    superviseRootTestChild(proc, {
      timeoutMs: SNAPSHOT_PROCESS_TIMEOUT_MS,
      shutdownGraceMs: ROOT_TEST_SHUTDOWN_GRACE_MS,
    }),
  ]);
  if (outcome.kind !== "exited") {
    throw new Error(
      `snapshot process exceeded ${SNAPSHOT_PROCESS_TIMEOUT_MS}ms; cleanup ${outcome.termination}`,
    );
  }
  return { exitCode: outcome.exitCode, stdout, stderr };
}
