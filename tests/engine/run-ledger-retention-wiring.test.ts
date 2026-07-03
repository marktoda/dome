// Host-wiring tests for run-ledger retention: `runCompilerHostTick`
// (src/engine/host/compiler-host.ts) applies the policy once at host
// startup (no cache file yet) and at most once per 24h thereafter
// (docs/wiki/specs/run-ledger.md §"Retention"). The SQL/vacuum decision
// itself is unit-tested in tests/ledger/retention.test.ts; this file
// exercises only the scheduling gate against a real `openVaultRuntime` +
// `runCompilerHostTick` (no mocks — a real git repo, real sqlite ledger).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commit, initRepo } from "../../src/git";
import { openVaultRuntime, type VaultRuntime } from "../../src/engine/host/vault-runtime";
import { runCompilerHostTick } from "../../src/engine/host/compiler-host";
import { readRunLedgerRetentionCache } from "../../src/engine/host/run-ledger-retention-cache";
import { countRuns } from "../../src/ledger/runs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");
const DAY_MS = 24 * 60 * 60 * 1000;

type Fixture = {
  readonly vaultPath: string;
  readonly cleanup: () => Promise<void>;
};

async function makeFixture(retentionDays: number): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "run-ledger-retention-wiring-"));
  await initRepo(vaultPath);
  await mkdir(join(vaultPath, "wiki"), { recursive: true });
  await writeFile(join(vaultPath, "wiki/seed.md"), "seed\n");
  await commit({ path: vaultPath, message: "init\n", files: ["wiki/seed.md"] });

  await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });
  await writeFile(
    join(vaultPath, ".dome", "config.yaml"),
    `
extensions: {}
ledger:
  retention_days: ${retentionDays}
`,
  );

  return {
    vaultPath,
    cleanup: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

function insertOldSucceededRun(runtime: VaultRuntime, id: string, startedAt: Date): void {
  const iso = startedAt.toISOString();
  runtime.ledgerDb.raw
    .query(
      `INSERT INTO runs (
        id, proposal_id, processor_id, processor_version, phase,
        input_commit, output_commit, status, effect_hashes_json,
        cost_usd, duration_ms, error, trigger_kind, trigger_payload_json,
        started_at, finished_at
      ) VALUES (?, NULL, 'test.processor', '0.1.0', 'view', 'deadbeef', NULL, 'succeeded', '[]', NULL, 5, NULL, 'command', '{}', ?, ?)`,
    )
    .run(id, iso, iso);
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

describe("run-ledger retention host wiring", () => {
  test("runs once at startup, then holds off for 24h, then re-fires", async () => {
    const f = await makeFixture(1); // retention_days: 1 — makes "2 days ago" eligible
    fixtures.push(f);
    const t0 = new Date("2026-07-02T00:00:00.000Z");

    const opened = await openVaultRuntime({
      vaultPath: f.vaultPath,
      bundlesRoot: SHIPPED_BUNDLES_ROOT,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const runtime = opened.value;
    try {
      // No cache file yet — this is the "at host startup" case.
      expect(readRunLedgerRetentionCache(f.vaultPath)).toBeNull();
      insertOldSucceededRun(runtime, "old-1", new Date(t0.getTime() - 2 * DAY_MS));

      await runCompilerHostTick({
        runtime,
        now: () => t0,
        runOperationalWhenInSync: false,
      });

      expect(countRuns(runtime.ledgerDb)).toBe(0);
      const cacheAfterFirstTick = readRunLedgerRetentionCache(f.vaultPath);
      expect(cacheAfterFirstTick?.lastPrunedAt).toBe(t0.toISOString());

      // A second old row lands after the first prune. Ticking again at the
      // SAME `now` must NOT prune it — the 24h guard is still open.
      insertOldSucceededRun(runtime, "old-2", new Date(t0.getTime() - 2 * DAY_MS));
      await runCompilerHostTick({
        runtime,
        now: () => t0,
        runOperationalWhenInSync: false,
      });
      expect(countRuns(runtime.ledgerDb)).toBe(1);
      expect(readRunLedgerRetentionCache(f.vaultPath)?.lastPrunedAt).toBe(
        t0.toISOString(),
      );

      // Advance past the 24h window: the next tick re-fires and prunes it.
      const t1 = new Date(t0.getTime() + 25 * 60 * 60 * 1000);
      await runCompilerHostTick({
        runtime,
        now: () => t1,
        runOperationalWhenInSync: false,
      });
      expect(countRuns(runtime.ledgerDb)).toBe(0);
      expect(readRunLedgerRetentionCache(f.vaultPath)?.lastPrunedAt).toBe(
        t1.toISOString(),
      );
    } finally {
      await runtime.close();
    }
  });

  test("retention_days: 0 disables retention — no cache file, rows survive", async () => {
    const f = await makeFixture(0);
    fixtures.push(f);
    const t0 = new Date("2026-07-02T00:00:00.000Z");

    const opened = await openVaultRuntime({
      vaultPath: f.vaultPath,
      bundlesRoot: SHIPPED_BUNDLES_ROOT,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const runtime = opened.value;
    try {
      insertOldSucceededRun(runtime, "ancient", new Date(t0.getTime() - 10_000 * DAY_MS));

      await runCompilerHostTick({
        runtime,
        now: () => t0,
        runOperationalWhenInSync: false,
      });

      expect(countRuns(runtime.ledgerDb)).toBe(1);
      expect(readRunLedgerRetentionCache(f.vaultPath)).toBeNull();
    } finally {
      await runtime.close();
    }
  });
});
