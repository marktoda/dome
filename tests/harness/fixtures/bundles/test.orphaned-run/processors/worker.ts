// A registered no-op processor whose only purpose is existing: scenarios
// simulating an orphaned running row need a `processorId` that resolves in
// the active `ProcessorRegistry`, so subject-liveness expiry
// (src/engine/operational/question-expiry.ts) does not treat the simulated
// orphan as a retired subject. Never actually scheduled to fire in those
// scenarios (the ledger row is seeded directly), but it must exist for the
// registry lookup to succeed.

import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "test.orphaned-run.worker",
  version: "0.1.0",
  phase: "garden",
  triggers: [{ kind: "schedule", cron: "* * * * *" }],
  capabilities: [],
  run: async () => [],
});
