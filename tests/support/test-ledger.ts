// Shared test helper: an in-memory run ledger.
//
// The engine write-path (adopt / garden / runtime / operational) requires a
// LedgerDb — every processor invocation is ledgered
// (EVERY_PROCESSOR_RUN_IS_LEDGERED). Tests that exercise those paths but don't
// care about ledger contents use this in-memory ledger: it applies the real
// schema with zero filesystem (no temp dir, no cleanup races). Caller closes
// it in teardown.

import { openLedgerDb, type LedgerDb } from "../../src/ledger/db";

export async function openTestLedger(): Promise<LedgerDb> {
  const result = await openLedgerDb({ path: ":memory:" });
  if (!result.ok) {
    throw new Error(`openTestLedger failed: ${JSON.stringify(result.error)}`);
  }
  return result.value.db;
}
