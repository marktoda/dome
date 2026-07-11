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
import { gardenCharter } from "../../assets/extensions/dome.agent/lib/garden-charter";
import { BREVITY_FRAGMENT } from "../../assets/extensions/dome.agent/lib/charter-fragments";
import { MAX_GARDEN_CHANGED_FILES } from "../../assets/extensions/dome.agent/processors/garden";

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

  test("dome.agent.garden charter (fixed inputs)", () => {
    expect(
      gardenCharter({
        maxChangedFiles: MAX_GARDEN_CHANGED_FILES,
        opportunity: {
          id: "possible-duplicate:123456abcdef",
          kind: "possible-duplicate",
          priority: 780,
          summary: "Two Acme pages may overlap",
          paths: ["wiki/entities/acme.md", "wiki/entities/acme-company.md"],
          evidence: ["title/description token similarity 0.82"],
        },
      }),
    ).toMatchSnapshot();
  });
});
