import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { openDeviceAuthority } from "../../src/device-authority/device-authority";
import type { FileChange } from "../../src/core/effect";
import { migratePreparedHomeStores } from "../../src/product-host/home-store-migrations";
import { proposalDedupeKey } from "../../src/proposals/pending-proposals";
import {
  assertFrozenN1RuntimeBaseline,
  assertFrozenN1State,
  establishFrozenN1RuntimeBaseline,
  FROZEN_N1_RELEASE,
  FROZEN_N1_PENDING_RUN_ID,
  FROZEN_N1_SOURCE_COMMIT,
  materializeFrozenN1Fixture,
  observeFrozenN1State,
  readFrozenN1Manifest,
} from "../fixtures/home-upgrade/n-1/freeze-n1";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "home-upgrade", "n-1", FROZEN_N1_RELEASE);

describe("frozen Home N-1 durable-state fixture", () => {
  test("materializes six real SQLite databases exclusively from frozen SQL", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-n1-consumer-"));
    try {
      const manifest = await materializeFrozenN1Fixture({ fixtureRoot: FIXTURE, destination: root });
      expect(manifest.sourceCommit).toBe(FROZEN_N1_SOURCE_COMMIT);
      expect(manifest.runtime).toEqual({ bun: "1.2.13", sqlite: "3.51.0" });
      expect(manifest.sourceFiles.map((entry) => entry.path)).toEqual([
        "src/answers/db.ts",
        "src/proposals/db.ts",
        "src/outbox/db.ts",
        "src/ledger/db.ts",
        "src/request-receipts/db.ts",
        "src/device-authority/device-authority.ts",
      ]);
      expect((await readdir(root)).sort()).toEqual([
        "answers.db",
        "device-authority.db",
        "outbox.db",
        "proposals.db",
        "request-receipts.db",
        "runs.db",
      ]);

      for (const store of manifest.stores) {
        const db = new Database(join(root, `${store.name}.db`), { readonly: true, create: false });
        try {
          expect(db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check).toBe("ok");
          expect(db.query<{ schema_hash: string }, []>(`SELECT schema_hash FROM ${store.metaTable}`).all())
            .toEqual([{ schema_hash: store.schemaHash }]);
        } finally { db.close(); }
      }

      const receiptDb = new Database(join(root, "request-receipts.db"), { readonly: true, create: false });
      try {
        expect(receiptDb.query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type='index' AND name='request_receipts_prunable'",
        ).all()).toEqual([]);
      } finally { receiptDb.close(); }

      const opened = await openDeviceAuthority({ path: join(root, "device-authority.db") });
      if (!opened.ok) throw new Error(JSON.stringify(opened.error));
      try {
        expect(opened.value.authority.authEpoch()).toBe(1);
        expect(opened.value.authority.authenticate({
          credential: manifest.authorityCanary.activeCredential,
          csrfSecret: manifest.authorityCanary.activeCsrf,
          requireCsrf: true,
          now: new Date("2026-07-13T12:16:00.000Z"),
        })).toEqual(expect.objectContaining({
          kind: "authenticated",
          actorId: "owner",
          device: expect.objectContaining({ id: manifest.authorityCanary.activeDeviceId, revokedAt: null }),
        }));
        expect(opened.value.authority.authenticate({
          credential: manifest.authorityCanary.revokedCredential,
          csrfSecret: manifest.authorityCanary.revokedCsrf,
          requireCsrf: true,
          now: new Date("2026-07-13T12:16:00.000Z"),
        })).toEqual({ kind: "revoked" });
        expect(opened.value.authority.listDevices().map((device) => [device.name, device.revokedAt !== null]))
          .toEqual([["Active Fixture", false], ["Revoked Fixture", true]]);
      } finally { opened.value.authority.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves raw startup recovery inputs under a live proposal owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-n1-runtime-baseline-"));
    try {
      await materializeFrozenN1Fixture({ fixtureRoot: FIXTURE, destination: root });
      const proposals = new Database(join(root, "proposals.db"), { readonly: true, create: false });
      const outbox = new Database(join(root, "outbox.db"), { readonly: true, create: false });
      const runs = new Database(join(root, "runs.db"), { readonly: true, create: false });
      const receipts = new Database(join(root, "request-receipts.db"), { readonly: true, create: false });
      const answers = new Database(join(root, "answers.db"), { readonly: true, create: false });
      try {
        const owner = proposals.query<{
          dedupe_key: string;
          processor_id: string;
          extension_id: string;
          run_id: string;
          changes_json: string;
          source_refs_json: string;
          base_commit: string;
          base_contents_json: string;
          created_at: string;
        }, []>(
          "SELECT dedupe_key,processor_id,extension_id,run_id,changes_json,source_refs_json," +
            "base_commit,base_contents_json,created_at FROM pending_proposals " +
            `WHERE run_id='${FROZEN_N1_PENDING_RUN_ID}' AND status='pending'`,
        ).get();
        if (owner === null) throw new Error("frozen pending proposal owner is missing");
        expect(owner.processor_id).toBe("dome.markdown.attic-sweep");
        expect(owner.extension_id).toBe("dome.markdown");
        const decodedChanges: unknown = JSON.parse(owner.changes_json);
        expect(decodedChanges).toEqual([
          { kind: "write", path: "attic/notes/Untitled.md", content: "# Untitled\n" },
          { kind: "delete", path: "notes/Untitled.md" },
        ]);
        const changes = decodedChanges as ReadonlyArray<FileChange>;
        expect(owner.dedupe_key).toBe(proposalDedupeKey(owner.processor_id, changes));
        expect(JSON.parse(owner.source_refs_json)).toEqual([{
          commit: owner.base_commit,
          path: "notes/Untitled.md",
        }]);
        expect(JSON.parse(owner.base_contents_json)).toEqual({
          "attic/notes/Untitled.md": null,
          "notes/Untitled.md": "# Untitled\n",
        });

        const exactN1 = extensionManifest(await gitShow(
          FROZEN_N1_SOURCE_COMMIT,
          "assets/extensions/dome.markdown/manifest.yaml",
        ));
        const current = extensionManifest(await readFile(
          join(import.meta.dir, "..", "..", "assets", "extensions", "dome.markdown", "manifest.yaml"),
          "utf8",
        ));
        for (const manifest of [exactN1, current]) {
          expect(manifest.id).toBe(owner.extension_id);
          const processor = manifest.processors.find((candidate) => candidate.id === owner.processor_id);
          expect(processor?.phase).toBe("garden");
          expect(processor?.capabilities.map((capability) => capability.kind)).toContain("patch.propose");
        }

        const linkedRun = runs.query<Record<string, unknown>, []>(
          "SELECT proposal_id,processor_id,processor_version,phase,status,output_commit," +
            "effect_hashes_json,cost_usd,duration_ms,trigger_kind," +
            `trigger_payload_json,started_at,finished_at FROM runs WHERE id='${FROZEN_N1_PENDING_RUN_ID}'`,
        ).get();
        expect(linkedRun).toEqual({
          proposal_id: null,
          processor_id: owner.processor_id,
          processor_version: "0.1.0",
          phase: "garden",
          status: "succeeded",
          output_commit: null,
          effect_hashes_json:
            '["efc999db3d8f2233265735978dcc8cdcb3fa95624bc91c7bbb9b0c783dd22a8e"]',
          cost_usd: null,
          duration_ms: 1000,
          trigger_kind: "schedule",
          trigger_payload_json:
            '[{"trigger":{"kind":"schedule","cron":"45 4 * * 0"},"matchedSignals":[]}]',
          started_at: "2026-07-12T08:45:00.000Z",
          finished_at: "2026-07-12T08:45:01.000Z",
        });
        expect(String(linkedRun?.["started_at"]) < owner.created_at).toBeTrue();
        expect(String(linkedRun?.["finished_at"]) > owner.created_at).toBeTrue();
        expect(runs.query<Record<string, unknown>, []>(
          "SELECT capability,resource,outcome,recorded_at FROM capability_uses " +
            `WHERE run_id='${FROZEN_N1_PENDING_RUN_ID}'`,
        ).get()).toEqual({
          capability: "patch.propose",
          resource: "attic/notes/Untitled.md,notes/Untitled.md",
          outcome: "allowed",
          recorded_at: owner.created_at,
        });
        expect(outbox.query<Record<string, unknown>, []>(
          "SELECT status,attempts,max_attempts,next_attempt_at,last_error FROM outbox " +
            "WHERE idempotency_key='outbox-pending'",
        ).get()).toEqual({
          status: "pending",
          attempts: 0,
          max_attempts: 3,
          next_attempt_at: "2026-07-13T12:08:00.000Z",
          last_error: null,
        });
        expect(receipts.query<Record<string, unknown>, []>(
          "SELECT state,result_code,adoption_state,recovery_required FROM request_receipts " +
            "WHERE operation_id='receipt-admitted'",
        ).get()).toEqual({
          state: "admitted",
          result_code: null,
          adoption_state: "none",
          recovery_required: 0,
        });
        expect(answers.query<Record<string, unknown>, []>(
          "SELECT handler_status,handler_attempts FROM question_answers " +
            "WHERE idempotency_key='answer-owner'",
        ).get()).toEqual({ handler_status: "pending", handler_attempts: 0 });
      } finally {
        proposals.close();
        outbox.close();
        runs.close();
        receipts.close();
        answers.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("establishes only the exact complete post-start runtime baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-n1-established-baseline-"));
    try {
      await materializeFrozenN1Fixture({ fixtureRoot: FIXTURE, destination: root });
      const outbox = new Database(join(root, "outbox.db"));
      const receipts = new Database(join(root, "request-receipts.db"));
      try {
        outbox.query(
          "UPDATE outbox SET status='failed',attempts=1," +
            "last_error=\"No external handler registered for capability 'notify.send'.\" " +
            "WHERE idempotency_key='outbox-pending'",
        ).run();
        receipts.query(
          "UPDATE request_receipts SET state='interrupted',result_code='host-restarted'," +
            "adoption_state='unknown',recovery_required=1,finished_at='2026-07-13T12:20:00.000Z' " +
            "WHERE operation_id='receipt-admitted'",
        ).run();
      } finally {
        outbox.close();
        receipts.close();
      }

      const baseline = await establishFrozenN1RuntimeBaseline({
        fixtureRoot: FIXTURE,
        stateRoot: root,
      });
      const repeated = await observeFrozenN1State({ fixtureRoot: FIXTURE, stateRoot: root });
      expect(() => assertFrozenN1RuntimeBaseline(repeated, baseline)).not.toThrow();

      const drift = new Database(join(root, "outbox.db"));
      try { drift.query("UPDATE outbox SET attempts=2 WHERE idempotency_key='outbox-failed'").run(); }
      finally { drift.close(); }
      await expect(establishFrozenN1RuntimeBaseline({
        fixtureRoot: FIXTURE,
        stateRoot: root,
      })).rejects.toThrow("baseline normalization changed: outbox");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to materialize over existing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-n1-exclusive-"));
    try {
      await materializeFrozenN1Fixture({ fixtureRoot: FIXTURE, destination: root });
      await expect(materializeFrozenN1Fixture({ fixtureRoot: FIXTURE, destination: root }))
        .rejects.toThrow("destination must be empty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("observes the six logical canaries and active/revoked credential truth", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-n1-observation-"));
    try {
      const manifest = await materializeFrozenN1Fixture({ fixtureRoot: FIXTURE, destination: root });
      const observation = await observeFrozenN1State({ fixtureRoot: FIXTURE, stateRoot: root });
      expect(() => assertFrozenN1State(observation, manifest)).not.toThrow();

      const answers = new Database(join(root, "answers.db"));
      try {
        answers.query("UPDATE question_answers SET handler_status = 'failed'").run();
      } finally { answers.close(); }
      const changed = await observeFrozenN1State({ fixtureRoot: FIXTURE, stateRoot: root });
      expect(() => assertFrozenN1State(changed, manifest)).toThrow("logical canary changed: answers");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("observes the same logical truth after the real N-1 to N migration", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dome-n1-migrated-observation-")));
    const preflight = await realpath(await mkdtemp(join(tmpdir(), "dome-n1-migrated-preflight-")));
    try {
      await chmod(preflight, 0o700);
      const manifest = await materializeFrozenN1Fixture({ fixtureRoot: FIXTURE, destination: root });
      await migratePreparedHomeStores({ stateRoot: root, preflightRoot: preflight });
      const observation = await observeFrozenN1State({ fixtureRoot: FIXTURE, stateRoot: root });
      expect(() => assertFrozenN1State(observation, manifest)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(preflight, { recursive: true, force: true });
    }
  });

  test("rejects open-world or redirected manifest evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "dome-n1-manifest-"));
    try {
      const original = JSON.parse(await readFile(join(FIXTURE, "manifest.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(root, "manifest.json"), JSON.stringify({ ...original, futureStorePolicy: true }));
      await expect(readFrozenN1Manifest(root)).rejects.toThrow("unknown or missing fields");

      const redirected = structuredClone(original) as { stores: Array<Record<string, unknown>> };
      redirected.stores[0]!["sql"] = "../answers.sql";
      await writeFile(join(root, "manifest.json"), JSON.stringify(redirected));
      await expect(readFrozenN1Manifest(root)).rejects.toThrow("not closed and sorted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

type BundleManifest = Readonly<{
  id: string;
  processors: ReadonlyArray<Readonly<{
    id: string;
    phase: string;
    capabilities: ReadonlyArray<Readonly<{ kind: string }>>;
  }>>;
}>;

function extensionManifest(source: string): BundleManifest {
  const value = parseYaml(source) as Partial<BundleManifest>;
  if (typeof value.id !== "string" || !Array.isArray(value.processors) ||
    value.processors.some((processor) => typeof processor?.id !== "string" ||
      typeof processor.phase !== "string" || !Array.isArray(processor.capabilities) ||
      processor.capabilities.some(
        (capability: Readonly<{ kind: string }>) => typeof capability?.kind !== "string",
      ))) {
    throw new Error("extension manifest lacks processor identity");
  }
  return value as BundleManifest;
}

async function gitShow(commit: string, path: string): Promise<string> {
  const repo = join(import.meta.dir, "..", "..");
  const child = Bun.spawn(["git", "show", `${commit}:${path}`], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr || `git show failed: ${path}`);
  return stdout;
}
