// Hermetic tests for dome.agent.sweep-answer — the deterministic answer handler
// for owner-gated sweep integrations. No model, no network, no filesystem.
//
// Input envelope shape: AnswerRunInput (src/engine/answers.ts:47):
//   { kind: "answer", questionId, question: { idempotencyKey, sourceRefs,
//     metadata? }, answer, answeredAt, matchedTriggers }

import { describe, expect, test } from "bun:test";

import sweepAnswer from "../../../assets/extensions/dome.agent/processors/sweep-answer";
import type {
  DiagnosticEffect,
  PatchEffect,
} from "../../../src/core/effect";
import type { ProcessorContext } from "../../../src/core/processor";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MATERIAL = "wiki/dailies/2026-06-09.md";
const DEST = "wiki/entities/alice-henshaw.md";
const ANSWERED_AT = "2026-06-10T08:00:00.000Z";

const UNCERTAIN_KEY = `dome.agent.sweep:uncertain:${MATERIAL}->${DEST}`;
const ESCALATE_KEY = `dome.agent.sweep:escalate:${MATERIAL}->${DEST}`;

const DEST_CONTENT = [
  "---",
  "type: entity",
  "sources: []",
  "---",
  "",
  "# Alice Henshaw",
  "",
  "## 2026-05-20 — first met",
  "Background chat.",
  "",
].join("\n");

function makeCtx(opts: {
  files?: Record<string, string>;
  input: unknown;
}): ProcessorContext {
  const files = opts.files ?? {};
  return {
    snapshot: {
      commit: "c" as never,
      tree: "t" as never,
      readFile: async (p: string) => files[p] ?? null,
      listMarkdownFiles: async () => Object.keys(files),
      getFileInfo: async () => null,
    },
    changedPaths: [],
    proposal: null,
    runId: "run-sweep-answer-test",
    input: opts.input,
    now: () => new Date(ANSWERED_AT),
    signal: new AbortController().signal,
    capabilities: {} as never,
    extensionConfig: {},
    sourceRef: (path: string) => ({ path }) as never,
  } as ProcessorContext;
}

function envelope(opts: {
  key?: string;
  answer: string;
  metadata?: Record<string, unknown>;
}): unknown {
  return {
    kind: "answer",
    questionId: 42,
    question: {
      idempotencyKey: opts.key ?? UNCERTAIN_KEY,
      sourceRefs: [],
      metadata: opts.metadata ?? {
        destination: DEST,
        material: MATERIAL,
        proposedSection: "## 2026-06-09 — hooks discussion\n\nShe demoed the new transformer hook.",
        automationPolicy: "owner-needed",
      },
    },
    answer: opts.answer,
    answeredAt: ANSWERED_AT,
    matchedTriggers: [],
  };
}

function patches(effects: ReadonlyArray<unknown>): PatchEffect[] {
  return (effects as ReadonlyArray<{ kind: string }>).filter(
    (e) => e.kind === "patch",
  ) as PatchEffect[];
}

function diagnostics(effects: ReadonlyArray<unknown>): DiagnosticEffect[] {
  return (effects as ReadonlyArray<{ kind: string }>).filter(
    (e) => e.kind === "diagnostic",
  ) as DiagnosticEffect[];
}

function patchContent(effects: ReadonlyArray<unknown>, path: string): string | null {
  for (const p of patches(effects)) {
    const change = p.changes.find((c) => String(c.path) === path);
    if (change?.kind === "write") return change.content;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test 1: integrate answer — proposed section appended + sources link present
// ---------------------------------------------------------------------------

describe("integrate answer on an uncertain question", () => {
  test("appends the proposed section and adds the sources link", async () => {
    const PROPOSED = "## 2026-06-09 — hooks discussion\n\nShe demoed the new transformer hook.";
    const ctx = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({
        answer: "integrate",
        metadata: {
          destination: DEST,
          material: MATERIAL,
          proposedSection: PROPOSED,
          automationPolicy: "owner-needed",
        },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(1);
    expect(diagnostics(effects)).toHaveLength(0);

    const patch = patches(effects)[0]!;
    expect(patch.mode).toBe("auto");
    expect(patch.changes).toHaveLength(1);
    expect(String(patch.changes[0]!.path)).toBe(DEST);

    const content = patchContent(effects, DEST) ?? "";
    // The proposed section (which starts with ## already) should appear verbatim.
    expect(content).toContain("## 2026-06-09 — hooks discussion");
    expect(content).toContain("She demoed the new transformer hook.");
    // The sources link must be present (settlement guarantee).
    expect(content).toContain(`[[${MATERIAL.replace(/\.md$/, "")}]]`);
  });
});

// ---------------------------------------------------------------------------
// Test 2: proposedSection already carrying its own ## heading — used verbatim
// ---------------------------------------------------------------------------

describe("proposedSection with own ## heading", () => {
  test("used verbatim — no double heading", async () => {
    const PROPOSED = "## 2026-06-09 — custom heading\n\nSome content.";
    const ctx = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({
        answer: "integrate",
        metadata: {
          destination: DEST,
          material: MATERIAL,
          proposedSection: PROPOSED,
        },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    const content = patchContent(effects, DEST) ?? "";
    // Should contain exactly the proposed heading once.
    const headingMatches = content.match(/## 2026-06-09 — custom heading/g);
    expect(headingMatches).toHaveLength(1);
    // No wrapping header should have been added.
    expect(content).not.toContain("integrated on owner approval");
  });

  test("proposedSection WITHOUT ## heading gets wrapped", async () => {
    const PROPOSED = "She demoed the new transformer hook."; // no heading
    const ctx = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({
        answer: "integrate",
        metadata: {
          destination: DEST,
          material: MATERIAL,
          proposedSection: PROPOSED,
        },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    const content = patchContent(effects, DEST) ?? "";
    // A fallback heading in house style should have been added.
    expect(content).toContain("## 2026-06-09 — integrated on owner approval");
    expect(content).toContain("She demoed the new transformer hook.");
  });
});

// ---------------------------------------------------------------------------
// Test 3: skip-answer → zero effects
// ---------------------------------------------------------------------------

describe("skip answer", () => {
  test("produces zero effects", async () => {
    const ctx = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({ answer: "skip" }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    expect(effects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: escalate-key answer (any value) → zero effects
// ---------------------------------------------------------------------------

describe("escalate-key answer", () => {
  test("any answer value → zero effects", async () => {
    for (const answer of ["skip", "integrate", "whatever"]) {
      const ctx = makeCtx({
        files: { [DEST]: DEST_CONTENT },
        input: envelope({ key: ESCALATE_KEY, answer }),
      });
      const effects = await sweepAnswer.run(ctx as never);
      expect(effects).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: malformed metadata (missing proposedSection) → invalid diagnostic, no patch
// ---------------------------------------------------------------------------

describe("malformed metadata on integrate", () => {
  test("missing proposedSection → warning diagnostic, no patch", async () => {
    const ctx = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({
        answer: "integrate",
        metadata: {
          destination: DEST,
          material: MATERIAL,
          // proposedSection intentionally absent
        },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
    expect(diagnostics(effects)[0]!.code).toBe("dome.agent.sweep-answer-invalid");
    expect(diagnostics(effects)[0]!.severity).toBe("warning");
  });

  test("empty proposedSection → warning diagnostic, no patch", async () => {
    const ctx = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({
        answer: "integrate",
        metadata: {
          destination: DEST,
          material: MATERIAL,
          proposedSection: "   ", // whitespace only
        },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)[0]!.code).toBe("dome.agent.sweep-answer-invalid");
  });

  test("missing destination in metadata → warning diagnostic, no patch", async () => {
    const ctx = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({
        answer: "integrate",
        metadata: {
          material: MATERIAL,
          proposedSection: "## 2026-06-09 — section\n\nContent.",
          // destination absent
        },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)[0]!.code).toBe("dome.agent.sweep-answer-invalid");
  });
});

// ---------------------------------------------------------------------------
// Test 6: missing destination file → missing-destination diagnostic, no patch
// ---------------------------------------------------------------------------

describe("missing destination file", () => {
  test("destination not in snapshot → missing-destination diagnostic, no patch", async () => {
    const ctx = makeCtx({
      files: {}, // destination absent from snapshot
      input: envelope({
        answer: "integrate",
        metadata: {
          destination: DEST,
          material: MATERIAL,
          proposedSection: "## 2026-06-09 — section\n\nContent.",
        },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
    expect(diagnostics(effects)[0]!.code).toBe("dome.agent.sweep-answer-missing-destination");
    expect(diagnostics(effects)[0]!.severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Test 7: destination already containing the sources link → ensureSourcesLink idempotent
// ---------------------------------------------------------------------------

describe("ensureSourcesLink idempotency via the handler", () => {
  test("sources link already present → no duplicate entry after integrate", async () => {
    const materialWithoutMd = MATERIAL.replace(/\.md$/, "");
    const destWithLink = [
      "---",
      "type: entity",
      "sources:",
      `  - "[[${materialWithoutMd}]]"`,
      "---",
      "",
      "# Alice Henshaw",
      "",
    ].join("\n");
    const ctx = makeCtx({
      files: { [DEST]: destWithLink },
      input: envelope({
        answer: "integrate",
        metadata: {
          destination: DEST,
          material: MATERIAL,
          proposedSection: "## 2026-06-09 — section\n\nContent.",
        },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    const content = patchContent(effects, DEST) ?? "";
    // The link should appear exactly once (the pre-existing one, not duplicated).
    const linkMatches = content.match(
      new RegExp(`\\[\\[${materialWithoutMd.replace(/\//g, "\\/")}\\]\\]`, "g"),
    );
    expect(linkMatches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 8: malformed envelope → invalid diagnostic, never throw
// ---------------------------------------------------------------------------

describe("malformed envelope", () => {
  test("null input → warning diagnostic", async () => {
    const ctx = makeCtx({ input: null });
    const effects = await sweepAnswer.run(ctx as never);
    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
    expect(diagnostics(effects)[0]!.code).toBe("dome.agent.sweep-answer-invalid");
  });

  test("missing answer field → warning diagnostic", async () => {
    const ctx = makeCtx({
      input: {
        kind: "answer",
        questionId: 1,
        question: { idempotencyKey: UNCERTAIN_KEY, sourceRefs: [] },
        // answer absent
        answeredAt: ANSWERED_AT,
        matchedTriggers: [],
      },
    });
    const effects = await sweepAnswer.run(ctx as never);
    expect(diagnostics(effects)).toHaveLength(1);
    expect(diagnostics(effects)[0]!.code).toBe("dome.agent.sweep-answer-invalid");
  });

  test("unknown key under dome.agent.sweep: prefix → warning diagnostic", async () => {
    const ctx = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({ key: "dome.agent.sweep:garbage:foo->bar", answer: "integrate" }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
    expect(diagnostics(effects)[0]!.code).toBe("dome.agent.sweep-answer-invalid");
  });
});

// ---------------------------------------------------------------------------
// Test 9: destination outside wiki/ → warning diagnostic, no patch
// ---------------------------------------------------------------------------

describe("destination outside wiki/", () => {
  test("outside wiki/ → warning diagnostic, no patch", async () => {
    const OUTSIDE_DEST = "core.md";
    const ctx = makeCtx({
      files: { [OUTSIDE_DEST]: "# Core\n" },
      input: envelope({
        answer: "integrate",
        metadata: {
          destination: OUTSIDE_DEST,
          material: MATERIAL,
          proposedSection: "## 2026-06-09 — section\n\nContent.",
        },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
    expect(diagnostics(effects)[0]!.code).toBe("dome.agent.sweep-answer-invalid");
  });
});

// ---------------------------------------------------------------------------
// Test 10: sourceRefs in the emitted patch cite material + destination
// ---------------------------------------------------------------------------

describe("patch sourceRefs", () => {
  test("emitted patch cites both material and destination", async () => {
    const ctx = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({
        answer: "integrate",
        metadata: {
          destination: DEST,
          material: MATERIAL,
          proposedSection: "## 2026-06-09 — hooks\n\nContent.",
        },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    const patch = patches(effects)[0]!;
    const refPaths = patch.sourceRefs.map((r) => String(r.path));
    expect(refPaths).toContain(MATERIAL);
    expect(refPaths).toContain(DEST);
  });
});

// ---------------------------------------------------------------------------
// Test 11: retry-idempotence presence guard
// ---------------------------------------------------------------------------

describe("retry idempotence — presence guard before append", () => {
  const PROPOSED = "## 2026-06-09 — hooks discussion\n\nShe demoed the new transformer hook.";
  const materialWithoutMd = MATERIAL.replace(/\.md$/, "");

  test("re-answering with the handler's own emitted content → zero effects", async () => {
    // First pass: get the emitted content.
    const ctx1 = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({
        answer: "integrate",
        metadata: { destination: DEST, material: MATERIAL, proposedSection: PROPOSED },
      }),
    });
    const effects1 = await sweepAnswer.run(ctx1 as never);
    const emittedContent = patchContent(effects1, DEST);
    expect(emittedContent).not.toBeNull();

    // Second pass (retry): feed the emitted content back as the snapshot.
    const ctx2 = makeCtx({
      files: { [DEST]: emittedContent! },
      input: envelope({
        answer: "integrate",
        metadata: { destination: DEST, material: MATERIAL, proposedSection: PROPOSED },
      }),
    });
    const effects2 = await sweepAnswer.run(ctx2 as never);
    // Retry must be zero effects — section already landed AND link already present.
    expect(effects2).toHaveLength(0);
  });

  test("section present but sources link missing → patch with link only, exactly one section occurrence", async () => {
    // Construct a destination that already has the section but NO sources link.
    const sectionAlreadyPresent = [
      "---",
      "type: entity",
      "sources: []",
      "---",
      "",
      "# Alice Henshaw",
      "",
      "## 2026-05-20 — first met",
      "Background chat.",
      "",
      "",
      PROPOSED,
      "",
    ].join("\n");

    const ctx = makeCtx({
      files: { [DEST]: sectionAlreadyPresent },
      input: envelope({
        answer: "integrate",
        metadata: { destination: DEST, material: MATERIAL, proposedSection: PROPOSED },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);

    // Must emit exactly one patch (link only) and no diagnostics.
    expect(patches(effects)).toHaveLength(1);
    expect(diagnostics(effects)).toHaveLength(0);

    const content = patchContent(effects, DEST) ?? "";
    // The section heading must appear exactly once.
    const headingMatches = content.match(/## 2026-06-09 — hooks discussion/g);
    expect(headingMatches).toHaveLength(1);
    // The sources link must now be present.
    expect(content).toContain(`[[${materialWithoutMd}]]`);
  });
});

// ---------------------------------------------------------------------------
// Test 12: trailing newline preservation
// ---------------------------------------------------------------------------

describe("trailing newline preservation", () => {
  test("happy path: full content snapshot — heading + section + sources + trailing newline", async () => {
    const PROPOSED = "## 2026-06-09 — hooks discussion\n\nShe demoed the new transformer hook.";
    const materialWithoutMd = MATERIAL.replace(/\.md$/, "");
    const ctx = makeCtx({
      files: { [DEST]: DEST_CONTENT },
      input: envelope({
        answer: "integrate",
        metadata: { destination: DEST, material: MATERIAL, proposedSection: PROPOSED },
      }),
    });
    const effects = await sweepAnswer.run(ctx as never);
    const content = patchContent(effects, DEST);
    expect(content).not.toBeNull();

    // Full-content assertion: ends with a newline, section and sources present.
    expect(content!.endsWith("\n")).toBe(true);
    expect(content).toContain("## 2026-06-09 — hooks discussion");
    expect(content).toContain("She demoed the new transformer hook.");
    expect(content).toContain(`[[${materialWithoutMd}]]`);

    // Exact structural check: one blank-line separator before the new section,
    // and the final character is a newline.
    const expectedSectionBlock = `\n\n${PROPOSED}\n`;
    expect(content).toContain(expectedSectionBlock);
  });
});
