import { describe, expect, test } from "bun:test";

import { BRIEF_CHARTER } from "../../assets/extensions/dome.agent/lib/brief-charter";
import { briefCase } from "../../src/eval/cases/brief";
import { hermeticEvalEnv } from "../../src/eval/provider";
import { BRIEF_BASIC_SCRIPT } from "../../src/eval/cases/brief-fixtures";

// Charter canary: the brief-gate in src/eval/cases/brief.ts keys on the exact
// opening sentence of the brief charter to route scripted steps only to the
// brief agent. If the charter is reworded this test fails loud rather than
// silently breaking the gate's dispatch logic.
const BRIEF_CHARTER_MARKER = "You are Dome's morning-brief composer.";

describe("briefCase charter canary", () => {
  test("brief charter still opens with the exact gate marker", () => {
    const charterText = Array.isArray(BRIEF_CHARTER)
      ? BRIEF_CHARTER.join("\n")
      : BRIEF_CHARTER;
    expect(charterText.startsWith(BRIEF_CHARTER_MARKER)).toBe(true);
  });
});

describe("briefCase (real-engine, hermetic)", () => {
  test("runs the brief through the engine and both assertions pass", async () => {
    const { env } = hermeticEvalEnv(BRIEF_BASIC_SCRIPT);

    const output = await briefCase.run(env);

    // The brief composed a real, adopted daily note read back from the
    // adopted commit (not an in-memory run(ctx) call).
    expect(output.brief.length).toBeGreaterThan(0);
    expect(output.brief).toContain("type: daily");
    expect(output.brief).toContain("## Open Loops");
    expect(output.brief).toContain("dome.agent.brief:");
    // The scripted grounded bullet survived the brief's grounding rule.
    expect(output.brief).toContain(
      "- Shipped the capture loop (from [[wiki/dailies/2026-06-08]])",
    );

    // The realized trajectory was captured via the env recorder: a read
    // (readPage) precedes the write (writePage).
    expect(output.trajectory.length).toBeGreaterThanOrEqual(2);
    expect(output.trajectory[0]?.toolCalls.map((c) => c.name)).toContain(
      "readPage",
    );

    // Both assertions report a pass (null reason).
    for (const assertion of briefCase.assertions) {
      expect(await assertion(output)).toBeNull();
    }
  });
});
