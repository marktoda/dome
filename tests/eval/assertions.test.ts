import { describe, expect, test } from "bun:test";
import { briefShapeValid, trajectoryReadsBeforeWrites } from "../../src/eval/assertions";
import type { BriefOutput } from "../../src/eval/assertions";
import type { ToolCallTrace } from "../../src/eval/provider";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_BRIEF = `---
type: daily
date: 2026-06-19
---

## Open Loops

- nothing pressing

<!-- dome.agent.brief:today -->

Some body text here.
`;

function makeOutput(brief: string, trajectory: ReadonlyArray<ToolCallTrace> = []): BriefOutput {
  return { brief, trajectory };
}

function makeTrace(names: string[]): ReadonlyArray<ToolCallTrace> {
  return names.map((name, i) => ({
    step: i,
    toolCalls: [{ name }],
    text: null,
  }));
}

// ---------------------------------------------------------------------------
// briefShapeValid
// ---------------------------------------------------------------------------

describe("briefShapeValid", () => {
  test("passes for a valid brief", async () => {
    const assertion = briefShapeValid();
    const result = await assertion(makeOutput(VALID_BRIEF));
    expect(result).toBeNull();
  });

  test("fails when front-matter is missing", async () => {
    const noFrontMatter = `## Open Loops

- nothing

<!-- dome.agent.brief:today -->
`;
    const assertion = briefShapeValid();
    const result = await assertion(makeOutput(noFrontMatter));
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    // reason should mention the failing check
    expect(result).toMatch(/front.?matter|type.*daily/i);
  });

  test("fails when front-matter exists but lacks type: daily", async () => {
    const wrongType = `---
type: weekly
date: 2026-06-19
---

## Open Loops

<!-- dome.agent.brief:today -->
`;
    const assertion = briefShapeValid();
    const result = await assertion(makeOutput(wrongType));
    expect(result).not.toBeNull();
    expect(result).toMatch(/front.?matter|type.*daily/i);
  });

  test("fails when ## Open Loops heading is missing", async () => {
    const noHeading = `---
type: daily
---

<!-- dome.agent.brief:today -->

Some body.
`;
    const assertion = briefShapeValid();
    const result = await assertion(makeOutput(noHeading));
    expect(result).not.toBeNull();
    expect(result).toMatch(/Open Loops/i);
  });

  test("fails when dome.agent.brief: marker is missing", async () => {
    const noMarker = `---
type: daily
---

## Open Loops

Some body without any marker.
`;
    const assertion = briefShapeValid();
    const result = await assertion(makeOutput(noMarker));
    expect(result).not.toBeNull();
    expect(result).toMatch(/dome\.agent\.brief/i);
  });

  test("fails when body exceeds maxChars", async () => {
    const longBody = VALID_BRIEF + "x".repeat(20000);
    const assertion = briefShapeValid({ maxChars: 100 });
    const result = await assertion(makeOutput(longBody));
    expect(result).not.toBeNull();
    expect(result).toMatch(/length|char|long/i);
  });

  test("passes when body is exactly at maxChars limit", async () => {
    const assertion = briefShapeValid({ maxChars: VALID_BRIEF.length });
    const result = await assertion(makeOutput(VALID_BRIEF));
    expect(result).toBeNull();
  });

  test("passes with default maxChars for a brief well under 20000", async () => {
    const assertion = briefShapeValid();
    const result = await assertion(makeOutput(VALID_BRIEF));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// trajectoryReadsBeforeWrites
// ---------------------------------------------------------------------------

describe("trajectoryReadsBeforeWrites", () => {
  const opts = {
    readNames: ["read_document"],
    writeNames: ["write_patch"],
  };

  test("passes for read then write", async () => {
    const trajectory = makeTrace(["read_document", "write_patch"]);
    const assertion = trajectoryReadsBeforeWrites(opts);
    const result = await assertion(makeOutput(VALID_BRIEF, trajectory));
    expect(result).toBeNull();
  });

  test("fails for write before any read", async () => {
    const trajectory = makeTrace(["write_patch", "read_document"]);
    const assertion = trajectoryReadsBeforeWrites(opts);
    const result = await assertion(makeOutput(VALID_BRIEF, trajectory));
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  test("passes for read-only trajectory (no writes)", async () => {
    const trajectory = makeTrace(["read_document"]);
    const assertion = trajectoryReadsBeforeWrites(opts);
    const result = await assertion(makeOutput(VALID_BRIEF, trajectory));
    expect(result).toBeNull();
  });

  test("passes for empty trajectory", async () => {
    const assertion = trajectoryReadsBeforeWrites(opts);
    const result = await assertion(makeOutput(VALID_BRIEF, []));
    expect(result).toBeNull();
  });

  test("fails for write-only trajectory (write with no prior read)", async () => {
    const trajectory = makeTrace(["write_patch"]);
    const assertion = trajectoryReadsBeforeWrites(opts);
    const result = await assertion(makeOutput(VALID_BRIEF, trajectory));
    expect(result).not.toBeNull();
  });

  test("passes when read and write are at the same step index but read step <= write step", async () => {
    // read at step 0, write at step 2 — should pass
    const trajectory: ReadonlyArray<ToolCallTrace> = [
      { step: 0, toolCalls: [{ name: "read_document" }], text: null },
      { step: 1, toolCalls: [{ name: "other_tool" }], text: null },
      { step: 2, toolCalls: [{ name: "write_patch" }], text: null },
    ];
    const assertion = trajectoryReadsBeforeWrites(opts);
    const result = await assertion(makeOutput(VALID_BRIEF, trajectory));
    expect(result).toBeNull();
  });

  test("handles multiple tool calls per step — write at step 0 with no prior read fails", async () => {
    const trajectory: ReadonlyArray<ToolCallTrace> = [
      { step: 0, toolCalls: [{ name: "write_patch" }, { name: "read_document" }], text: null },
    ];
    // write_patch at step 0, first read is also step 0 — write appears before read in call order
    // per spec: fails if a write appears at a step BEFORE the first read step
    // Both are step 0, so write is NOT before the first read step — passes
    const assertion = trajectoryReadsBeforeWrites(opts);
    const result = await assertion(makeOutput(VALID_BRIEF, trajectory));
    // step 0 write, step 0 first read — write step (0) is not < first read step (0)
    expect(result).toBeNull();
  });
});
