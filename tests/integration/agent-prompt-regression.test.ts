// tests/integration/agent-prompt-regression.test.ts
//
// Snapshot fence for docs/wiki/gotchas/agent-prompt-regression.md: the LLM
// charters are behavior-bearing config. Any edit must show up as a snapshot
// diff in review. Intentional changes: update the prompt, run
// `bun test tests/integration/agent-prompt-regression.test.ts --update-snapshots`,
// and commit the .snap diff alongside the prompt change.

import { describe, expect, test } from "bun:test";

import { BRIEF_CHARTER } from "../../assets/extensions/dome.agent/lib/brief-charter";
import { INGEST_CHARTER } from "../../assets/extensions/dome.agent/lib/ingest-charter";
import { consolidateCharter } from "../../assets/extensions/dome.agent/lib/consolidate-charter";
import { BREVITY_FRAGMENT } from "../../assets/extensions/dome.agent/lib/charter-fragments";
import { MAX_CHANGED_FILES } from "../../assets/extensions/dome.agent/processors/consolidate";
import { sweepCharter } from "../../assets/extensions/dome.agent/lib/sweep-charter";

describe("agent prompt regression", () => {
  test("brief and ingest share one brevity fragment", () => {
    expect(BRIEF_CHARTER).toContain(BREVITY_FRAGMENT);
    expect(INGEST_CHARTER).toContain(BREVITY_FRAGMENT);
  });

  test("brief charter instructs surfacing actionable findings via addTask", () => {
    expect(BRIEF_CHARTER).toContain("addTask");
  });

  test("dome.agent.brief charter", () => {
    expect(BRIEF_CHARTER).toMatchSnapshot();
  });

  test("dome.agent.ingest charter", () => {
    expect(INGEST_CHARTER).toMatchSnapshot();
  });

  test("dome.agent.consolidate charter (fixed inputs)", () => {
    expect(
      consolidateCharter({
        ledgerPath: "wiki/meta/consolidation-ledger.md",
        maxChangedFiles: MAX_CHANGED_FILES,
        targets: ["wiki/"],
      }),
    ).toMatchSnapshot();
  });

  test("dome.agent.sweep charter (fixed inputs)", () => {
    expect(
      sweepCharter({
        destination: "wiki/entities/acme.md",
        material: "inbox/raw/2026-06-01-standup.md",
        materialDate: "2026-06-01",
      }),
    ).toMatchSnapshot();
  });

});
