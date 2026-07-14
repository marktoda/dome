import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDeviceAuthority } from "../../src/device-authority/device-authority";
import { migratePreparedHomeStores } from "../../src/product-host/home-store-migrations";
import {
  assertFrozenN1State,
  FROZEN_N1_RELEASE,
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
