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
    // Both suggested remedies exempt failure forensics; the recovery text
    // must name that failure mode so a "prune did nothing" operator isn't
    // left guessing (the fix is the failing processor, not the window).
    expect(finding.recovery).toContain("failure-forensics");
    expect(finding.recovery).toContain("dome inspect runs --status failed");
    expect(finding.ledger).toEqual({
      path: RUNS_DB_PATH,
      sizeBytes,
      thresholdBytes: DEFAULT_LEDGER_OVERSIZED_THRESHOLD_BYTES,
      retainedForensicsRows: null,
    });
  });

  test("includes the retained-forensics count when a counter is supplied", () => {
    const sizeBytes = DEFAULT_LEDGER_OVERSIZED_THRESHOLD_BYTES + 1024;
    const finding = ledgerOversizedFinding({
      path: RUNS_DB_PATH,
      sizeBytes,
      countRetainedForensicsRows: () => 42,
    });
    expect(finding).not.toBeNull();
    if (finding === null || finding.code !== "ledger.oversized") return;
    expect(finding.ledger.retainedForensicsRows).toBe(42);
    expect(finding.message).toContain("42 row(s) are failure forensics");
  });

  test("the forensics counter is lazy — never invoked under the threshold", () => {
    let invoked = false;
    const finding = ledgerOversizedFinding({
      path: RUNS_DB_PATH,
      sizeBytes: 1,
      countRetainedForensicsRows: () => {
        invoked = true;
        return 0;
      },
    });
    expect(finding).toBeNull();
    expect(invoked).toBe(false);
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
