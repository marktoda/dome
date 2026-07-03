// The `ledger.oversized` info probe (`ledgerOversizedFinding`,
// src/engine/host/health/operational.ts).
//
// Pure detection function: no filesystem I/O here (the registry.ts wiring
// does the `statSync`) — see tests/cli/commands/doctor.test.ts for the
// end-to-end wiring test against a real (sparse-extended) runs.db file.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_LEDGER_OVERSIZED_THRESHOLD_BYTES,
  ledgerOversizedFinding,
} from "../../src/engine/host/health";

const RUNS_DB_PATH = "/vault/.dome/state/runs.db";

describe("ledger.oversized", () => {
  test("returns null at or under the default 500MB threshold", () => {
    expect(
      ledgerOversizedFinding({
        path: RUNS_DB_PATH,
        sizeBytes: DEFAULT_LEDGER_OVERSIZED_THRESHOLD_BYTES,
      }),
    ).toBeNull();
    expect(
      ledgerOversizedFinding({
        path: RUNS_DB_PATH,
        sizeBytes: DEFAULT_LEDGER_OVERSIZED_THRESHOLD_BYTES - 1,
      }),
    ).toBeNull();
  });

  test("raises an info finding over the default threshold", () => {
    const sizeBytes = DEFAULT_LEDGER_OVERSIZED_THRESHOLD_BYTES + 1024;
    const finding = ledgerOversizedFinding({ path: RUNS_DB_PATH, sizeBytes });
    expect(finding).not.toBeNull();
    if (finding === null || finding.code !== "ledger.oversized") return;
    expect(finding.code).toBe("ledger.oversized");
    expect(finding.severity).toBe("info");
    expect(finding.subject).toBe("runs");
    expect(finding.id).toBe("runs_db");
    expect(finding.message).toContain("500 MB");
    expect(finding.recovery).toContain("ledger.retention_days");
    expect(finding.ledger).toEqual({
      path: RUNS_DB_PATH,
      sizeBytes,
      thresholdBytes: DEFAULT_LEDGER_OVERSIZED_THRESHOLD_BYTES,
    });
  });

  test("honors a custom threshold override", () => {
    expect(
      ledgerOversizedFinding({
        path: RUNS_DB_PATH,
        sizeBytes: 2048,
        thresholdBytes: 1024,
      }),
    ).not.toBeNull();
    expect(
      ledgerOversizedFinding({
        path: RUNS_DB_PATH,
        sizeBytes: 1024,
        thresholdBytes: 1024,
      }),
    ).toBeNull();
  });
});
