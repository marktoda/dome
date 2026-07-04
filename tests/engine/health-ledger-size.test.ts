// The oversized-ledger probe (`ledger.oversized`).
//
// `runs.db` growing unbounded costs real disk — the work-vault reclaim that
// motivated wiring `ledger.retention_days` (wiki/specs/run-ledger.md
// §Retention) started from a multi-hundred-MB runs.db nobody noticed until
// disk pressure forced the question. `dome doctor`/`dome check` surface it
// directly instead of relying on the operator to stumble onto it. The probe
// takes an injected file size (rather than statSync-ing a real file) so
// tests never need to create a real 512MB fixture.

import { describe, expect, test } from "bun:test";

import {
  LEDGER_SIZE_WARNING_BYTES,
  ledgerOversizedFinding,
} from "../../src/engine/host/health/operational";

const RUNS_DB_PATH = "/vault/.dome/state/runs.db";

describe("ledgerOversizedFinding", () => {
  test("size above threshold -> one warning finding naming the size (MB) and both remedies", () => {
    const finding = ledgerOversizedFinding({
      path: RUNS_DB_PATH,
      fileSizeBytes: LEDGER_SIZE_WARNING_BYTES + 10 * 1024 * 1024,
    });
    expect(finding).not.toBeNull();
    if (finding === null) return;
    expect(finding.code).toBe("ledger.oversized");
    expect(finding.severity).toBe("warning");
    expect(finding.subject).toBe("storage");
    expect(finding.message).toContain("522 MB");
    expect(finding.recovery).toContain("ledger.retention_days");
    expect(finding.recovery).toContain(".dome/config.yaml");
    expect(finding.recovery).toContain(
      "dome repair run-ledger --apply --vacuum",
    );
    if (finding.code === "ledger.oversized") {
      expect(finding.storage.path).toBe(RUNS_DB_PATH);
      expect(finding.storage.sizeBytes).toBe(
        LEDGER_SIZE_WARNING_BYTES + 10 * 1024 * 1024,
      );
    }
  });

  test("size exactly at the threshold -> finding (threshold is inclusive)", () => {
    expect(
      ledgerOversizedFinding({
        path: RUNS_DB_PATH,
        fileSizeBytes: LEDGER_SIZE_WARNING_BYTES,
      }),
    ).not.toBeNull();
  });

  test("size below threshold -> no finding", () => {
    expect(
      ledgerOversizedFinding({
        path: RUNS_DB_PATH,
        fileSizeBytes: LEDGER_SIZE_WARNING_BYTES - 1,
      }),
    ).toBeNull();
  });

  test("missing file (null size) -> no finding", () => {
    expect(
      ledgerOversizedFinding({ path: RUNS_DB_PATH, fileSizeBytes: null }),
    ).toBeNull();
  });
});
