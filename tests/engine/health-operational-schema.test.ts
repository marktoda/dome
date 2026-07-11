// The operational-schema mismatch probe (`operational.schema-mismatch`).
//
// `dome doctor`/`dome check` read stored schema hashes from answers.db /
// outbox.db / runs.db BEFORE opening the runtime (collectOperationalSchemaReport
// is a probe-only step ahead of openVaultRuntime). But answers.db and
// outbox.db both use `{kind:"migrate"}` open policies that upgrade ONE known
// prior hash in place, automatically, the next time the vault opens — so a
// store sitting on exactly that prior hash isn't broken, it self-heals. Prior
// to this fix, `operationalSchemaFinding` treated ANY mismatch (including
// this self-healing one) as an `error`-severity finding, which made
// `dome doctor`/`dome check` short-circuit before the runtime ever got a
// chance to run the migration. Unknown/other mismatches (a genuinely
// unrecoverable schema) must still be a hard error.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY,
  ANSWERS_SCHEMA_HASH_BEFORE_AGENT_CONTEXT,
} from "../../src/answers/db";
import { OUTBOX_SCHEMA_HASH_BEFORE_NEXT_ATTEMPT_AT } from "../../src/outbox/db";
import {
  collectOperationalSchemaFindings,
  operationalSchemaFinding,
} from "../../src/engine/host/health/operational";

function seedMetaTable(path: string, table: string, hash: string): void {
  const db = new Database(path, { create: true });
  db.run(
    `CREATE TABLE ${table} (schema_hash TEXT NOT NULL PRIMARY KEY, built_at TEXT NOT NULL)`,
  );
  db.run(
    `INSERT INTO ${table} (schema_hash, built_at) VALUES (?, ?)`,
    [hash, "2026-01-01T00:00:00.000Z"],
  );
  db.close();
}

describe("operationalSchemaFinding: known-migratable prior hashes are info, not error", () => {
  function withTempDb(hash: string, table: string, run: (path: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "dome-health-schema-"));
    try {
      const path = join(root, "store.db");
      seedMetaTable(path, table, hash);
      run(path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("answers.db on the known pre-answered_by hash -> info finding, mentions auto-migration on next open", () => {
    withTempDb(ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY, "answers_meta", (path) => {
      const finding = operationalSchemaFinding({
        database: "answers",
        path,
        table: "answers_meta",
        expected: "current-answers-hash",
        knownPriorHashes: [ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY],
      });
      expect(finding).not.toBeNull();
      if (finding === null) return;
      expect(finding.severity).toBe("info");
      expect(finding.code).toBe("operational.schema-mismatch");
      expect(finding.message.toLowerCase()).toContain("migrates in place automatically");
      expect(finding.message.toLowerCase()).toContain("next time the vault opens");
      expect(finding.recovery.toLowerCase()).not.toContain("compatible dome version");
      if (finding.code === "operational.schema-mismatch") {
        expect(finding.storage.database).toBe("answers");
        expect(finding.storage.stored).toBe(ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY);
      }
    });
  });

  test("answers.db on the pre-agent-context hash is also migratable", () => {
    withTempDb(ANSWERS_SCHEMA_HASH_BEFORE_AGENT_CONTEXT, "answers_meta", (path) => {
      const finding = operationalSchemaFinding({
        database: "answers",
        path,
        table: "answers_meta",
        expected: "current-answers-hash",
        knownPriorHashes: [
          ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY,
          ANSWERS_SCHEMA_HASH_BEFORE_AGENT_CONTEXT,
        ],
      });
      expect(finding?.severity).toBe("info");
    });
  });

  test("outbox.db on the known pre-next_attempt_at hash -> info finding, mentions auto-migration on next open", () => {
    withTempDb(OUTBOX_SCHEMA_HASH_BEFORE_NEXT_ATTEMPT_AT, "outbox_meta", (path) => {
      const finding = operationalSchemaFinding({
        database: "outbox",
        path,
        table: "outbox_meta",
        expected: "current-outbox-hash",
        knownPriorHashes: [OUTBOX_SCHEMA_HASH_BEFORE_NEXT_ATTEMPT_AT],
      });
      expect(finding).not.toBeNull();
      if (finding === null) return;
      expect(finding.severity).toBe("info");
      expect(finding.message.toLowerCase()).toContain("migrates in place automatically");
      expect(finding.message.toLowerCase()).toContain("next time the vault opens");
    });
  });

  test("unknown stored hash stays error severity (pinned existing behavior)", () => {
    withTempDb("some-unknown-hash", "answers_meta", (path) => {
      const finding = operationalSchemaFinding({
        database: "answers",
        path,
        table: "answers_meta",
        expected: "current-answers-hash",
        knownPriorHashes: [ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY],
      });
      expect(finding).not.toBeNull();
      if (finding === null) return;
      expect(finding.severity).toBe("error");
      expect(finding.message).toContain("some-unknown-hash");
      expect(finding.recovery.toLowerCase()).toContain("compatible dome version");
    });
  });

  test("ledger (no known prior hash configured) still hard-errors on any mismatch", () => {
    withTempDb("some-unknown-ledger-hash", "ledger_meta", (path) => {
      const finding = operationalSchemaFinding({
        database: "ledger",
        path,
        table: "ledger_meta",
        expected: "current-ledger-hash",
      });
      expect(finding).not.toBeNull();
      if (finding === null) return;
      expect(finding.severity).toBe("error");
    });
  });

  test("matching hash never raises a finding, migratable or not", () => {
    withTempDb(ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY, "answers_meta", (path) => {
      const finding = operationalSchemaFinding({
        database: "answers",
        path,
        table: "answers_meta",
        expected: ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY,
        knownPriorHashes: [ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY],
      });
      expect(finding).toBeNull();
    });
  });
});

describe("collectOperationalSchemaFindings: wires the known prior hash per store", () => {
  test("a vault whose answers.db sits on the known prior hash reports info, not error", () => {
    const root = mkdtempSync(join(tmpdir(), "dome-health-schema-collect-"));
    try {
      const statePath = join(root, ".dome", "state");
      mkdirSync(statePath, { recursive: true });
      seedMetaTable(
        join(statePath, "answers.db"),
        "answers_meta",
        ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY,
      );
      const findings = collectOperationalSchemaFindings(root);
      const answersFinding = findings.find((f) => f.id === "answers.schema");
      expect(answersFinding).toBeDefined();
      expect(answersFinding?.severity).toBe("info");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
