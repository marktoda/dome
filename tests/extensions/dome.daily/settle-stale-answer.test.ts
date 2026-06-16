// dome.daily.settle-stale-answer — unit tests for the deterministic answer
// handler that applies the owner's disposition (close / defer / keep) to a
// stale task identified by its ^anchor in a source file.
//
// Input envelope: same "answer" envelope shape as sweep-answer.
//   { kind: "answer", questionId, question: { idempotencyKey, sourceRefs,
//     metadata: { destination, material (= anchor), ... } }, answer, answeredAt }
//
// Dispositions:
//   close  — changes `- [ ] ` → `- [-] ` (cancelled). Idempotent: already-[-] → no patch.
//   defer  — moves (or adds) the `📅 YYYY-MM-DD` date forward by DEFER_DAYS (=7) from today.
//            The ^anchor stays trailing; the origin marker ([↗](...)) is preserved.
//   keep   — no effects.
//
// The handler locates the target line by scanning for a trailing ` ^<anchor>` suffix
// within the destination file (metadata.destination) using metadata.material as the anchor.
//
// Harness mirrors sweep-answer.test.ts: makeCtx / envelope / patches / diagnostics helpers.

import { describe, expect, test } from "bun:test";

import settleStaleAnswer from "../../../assets/extensions/dome.daily/processors/settle-stale-answer";
import type {
  DiagnosticEffect,
  PatchEffect,
} from "../../../src/core/effect";
import type { ProcessorContext } from "../../../src/core/processor";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// "today" = 2026-06-15; DEFER_DAYS = 7 → deferred to 2026-06-22
const NOW_ISO = "2026-06-15T08:00:00.000Z";
const TODAY = "2026-06-15";
const DEFERRED_DATE = "2026-06-22"; // TODAY + 7

const ANCHOR = "tabc123def456";
const DEST = "wiki/projects/alpha.md";

// A simple stale task line (overdue dated task)
const TASK_BODY_WITH_DATE = `#task do thing 📅 2026-06-01`;
const OPEN_TASK_LINE = `- [ ] ${TASK_BODY_WITH_DATE} ^${ANCHOR}`;
const CLOSED_TASK_LINE = `- [-] ${TASK_BODY_WITH_DATE} ^${ANCHOR}`;
const DEFERRED_TASK_LINE = `- [ ] #task do thing 📅 ${DEFERRED_DATE} ^${ANCHOR}`;

// Task line without a due date (for defer-adds-date case)
const TASK_BODY_NO_DATE = `#task plan the thing`;
const OPEN_NO_DATE_LINE = `- [ ] ${TASK_BODY_NO_DATE} ^${ANCHOR}`;
const DEFERRED_NO_DATE_LINE = `- [ ] #task plan the thing 📅 ${DEFERRED_DATE} ^${ANCHOR}`;

// Task line with an origin marker ([↗](target)) and anchor — defer must preserve both
const ORIGIN_TARGET = "wiki/projects/source.md";
const ORIGIN_ENCODED = "wiki/projects/source.md"; // no parens to encode here
const TASK_WITH_ORIGIN_LINE = `- [ ] #task do thing 📅 2026-06-01 ([↗](${ORIGIN_ENCODED})) ^${ANCHOR}`;
const DEFERRED_WITH_ORIGIN_LINE = `- [ ] #task do thing 📅 ${DEFERRED_DATE} ([↗](${ORIGIN_ENCODED})) ^${ANCHOR}`;

function makeFileContent(taskLine: string): string {
  return [
    "# Alpha Project",
    "",
    "Some notes here.",
    "",
    taskLine,
    "",
    "Other content.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

function makeCtx(opts: {
  files?: Record<string, string>;
  input: unknown;
  now?: Date;
}): ProcessorContext {
  const files = opts.files ?? {};
  const now = opts.now ?? new Date(NOW_ISO);
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
    runId: "run-settle-stale-answer-test",
    input: opts.input,
    now: () => now,
    signal: new AbortController().signal,
    capabilities: {} as never,
    extensionConfig: {},
    sourceRef: (path: string) => ({ path }) as never,
  } as ProcessorContext;
}

function envelope(opts: {
  key?: string;
  answer: string;
  destination?: string;
  material?: string;
}): unknown {
  const key = opts.key ?? `dome.daily.settle-stale:dome.daily.open-loop:${ANCHOR}`;
  return {
    kind: "answer",
    questionId: 99,
    question: {
      idempotencyKey: key,
      sourceRefs: [],
      metadata: {
        automationPolicy: "owner-needed",
        recommendedAnswer: "keep",
        destination: opts.destination ?? DEST,
        material: opts.material ?? ANCHOR,
      },
    },
    answer: opts.answer,
    answeredAt: NOW_ISO,
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
// Test 1: close disposition — open → cancelled
// ---------------------------------------------------------------------------

describe("close answer", () => {
  test("changes `- [ ]` to `- [-]` on a stale overdue task, preserving anchor and date", async () => {
    const fileContent = makeFileContent(OPEN_TASK_LINE);
    const ctx = makeCtx({
      files: { [DEST]: fileContent },
      input: envelope({ answer: "close" }),
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(1);
    expect(diagnostics(effects)).toHaveLength(0);

    const patch = patches(effects)[0]!;
    expect(patch.mode).toBe("auto");
    expect(patch.changes).toHaveLength(1);
    expect(String(patch.changes[0]!.path)).toBe(DEST);

    const content = patchContent(effects, DEST) ?? "";
    expect(content).toContain(CLOSED_TASK_LINE);
    expect(content).not.toContain(OPEN_TASK_LINE);
    // anchor is preserved
    expect(content).toContain(`^${ANCHOR}`);
  });

  test("idempotent: already-[-] line → zero effects (no double-patch)", async () => {
    const fileContent = makeFileContent(CLOSED_TASK_LINE);
    const ctx = makeCtx({
      files: { [DEST]: fileContent },
      input: envelope({ answer: "close" }),
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(effects).toHaveLength(0);
  });

  test("does not affect other lines in the file", async () => {
    const otherLine = `- [ ] #task something else 📅 2026-05-01 ^tother1234`;
    const fileContent = [
      "# Alpha",
      "",
      OPEN_TASK_LINE,
      "",
      otherLine,
      "",
    ].join("\n");
    const ctx = makeCtx({
      files: { [DEST]: fileContent },
      input: envelope({ answer: "close" }),
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    const content = patchContent(effects, DEST) ?? "";
    // Target line is closed
    expect(content).toContain(CLOSED_TASK_LINE);
    // Other line is untouched (still open)
    expect(content).toContain(otherLine);
  });
});

// ---------------------------------------------------------------------------
// Test 2: defer disposition — move the 📅 date forward by DEFER_DAYS
// ---------------------------------------------------------------------------

describe("defer answer", () => {
  test("moves the 📅 date to TODAY + DEFER_DAYS, preserving anchor", async () => {
    const fileContent = makeFileContent(OPEN_TASK_LINE);
    const ctx = makeCtx({
      files: { [DEST]: fileContent },
      input: envelope({ answer: "defer" }),
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(1);
    expect(diagnostics(effects)).toHaveLength(0);

    const content = patchContent(effects, DEST) ?? "";
    expect(content).toContain(DEFERRED_TASK_LINE);
    expect(content).not.toContain("📅 2026-06-01");
    expect(content).toContain(`📅 ${DEFERRED_DATE}`);
    expect(content).toContain(`^${ANCHOR}`);
  });

  test("adds a 📅 date when the task has none, anchor stays trailing", async () => {
    const fileContent = makeFileContent(OPEN_NO_DATE_LINE);
    const ctx = makeCtx({
      files: { [DEST]: fileContent },
      input: envelope({ answer: "defer" }),
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(1);
    const content = patchContent(effects, DEST) ?? "";
    expect(content).toContain(DEFERRED_NO_DATE_LINE);
    // anchor is trailing (last token on the line)
    const lines = content.split("\n");
    const taskLine = lines.find((l) => l.includes(`^${ANCHOR}`));
    expect(taskLine).toBeDefined();
    expect(taskLine!.trimEnd()).toMatch(/\^[A-Za-z0-9-]+$/);
  });

  test("preserves the origin marker ([↗](...)) and keeps ^anchor trailing", async () => {
    const fileContent = makeFileContent(TASK_WITH_ORIGIN_LINE);
    const ctx = makeCtx({
      files: { [DEST]: fileContent },
      input: envelope({ answer: "defer" }),
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(1);
    const content = patchContent(effects, DEST) ?? "";
    expect(content).toContain(DEFERRED_WITH_ORIGIN_LINE);
    // Origin marker is present
    expect(content).toContain(`([↗](${ORIGIN_ENCODED}))`);
    // Anchor is trailing
    const lines = content.split("\n");
    const taskLine = lines.find((l) => l.includes(`^${ANCHOR}`));
    expect(taskLine!.trimEnd()).toMatch(/\^[A-Za-z0-9-]+$/);
    // Anchor appears after the origin marker on the same line
    expect(taskLine).toBeDefined();
    const anchorIdx = taskLine!.indexOf(`^${ANCHOR}`);
    const markerIdx = taskLine!.indexOf(`([↗](`);
    expect(markerIdx).toBeLessThan(anchorIdx);
  });
});

// ---------------------------------------------------------------------------
// Test 3: keep disposition — no effects
// ---------------------------------------------------------------------------

describe("keep answer", () => {
  test("produces zero effects", async () => {
    const fileContent = makeFileContent(OPEN_TASK_LINE);
    const ctx = makeCtx({
      files: { [DEST]: fileContent },
      input: envelope({ answer: "keep" }),
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(effects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: anchor not found in destination
// ---------------------------------------------------------------------------

describe("anchor not found", () => {
  test("close answer where anchor is absent → diagnostic warning, no patch", async () => {
    const fileContent = "# Alpha\n\nNo tasks here.\n";
    const ctx = makeCtx({
      files: { [DEST]: fileContent },
      input: envelope({ answer: "close", material: "tmissinganchor" }),
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
    expect(diagnostics(effects)[0]!.severity).toBe("warning");
  });

  test("defer answer where anchor is absent → diagnostic warning, no patch", async () => {
    const fileContent = "# Alpha\n\nNo tasks here.\n";
    const ctx = makeCtx({
      files: { [DEST]: fileContent },
      input: envelope({ answer: "defer", material: "tmissinganchor" }),
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5: destination file not in snapshot
// ---------------------------------------------------------------------------

describe("destination file missing", () => {
  test("close answer → diagnostic warning, no patch", async () => {
    const ctx = makeCtx({
      files: {}, // destination absent
      input: envelope({ answer: "close" }),
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
    expect(diagnostics(effects)[0]!.severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Test 6: malformed envelope → diagnostic, never throw
// ---------------------------------------------------------------------------

describe("malformed envelope", () => {
  test("null input → warning diagnostic", async () => {
    const ctx = makeCtx({ input: null });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
    expect(diagnostics(effects)[0]!.severity).toBe("warning");
  });

  test("missing material in metadata → warning diagnostic", async () => {
    const ctx = makeCtx({
      files: { [DEST]: makeFileContent(OPEN_TASK_LINE) },
      input: {
        kind: "answer",
        questionId: 1,
        question: {
          idempotencyKey: `dome.daily.settle-stale:dome.daily.open-loop:${ANCHOR}`,
          sourceRefs: [],
          metadata: {
            automationPolicy: "owner-needed",
            destination: DEST,
            // material intentionally absent
          },
        },
        answer: "close",
        answeredAt: NOW_ISO,
        matchedTriggers: [],
      },
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
  });

  test("missing destination in metadata → warning diagnostic", async () => {
    const ctx = makeCtx({
      files: { [DEST]: makeFileContent(OPEN_TASK_LINE) },
      input: {
        kind: "answer",
        questionId: 1,
        question: {
          idempotencyKey: `dome.daily.settle-stale:dome.daily.open-loop:${ANCHOR}`,
          sourceRefs: [],
          metadata: {
            automationPolicy: "owner-needed",
            material: ANCHOR,
            // destination intentionally absent
          },
        },
        answer: "close",
        answeredAt: NOW_ISO,
        matchedTriggers: [],
      },
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(patches(effects)).toHaveLength(0);
    expect(diagnostics(effects)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 7: unknown answer value → zero effects (not a diagnostic — just ignore)
// ---------------------------------------------------------------------------

describe("unknown answer value", () => {
  test("unrecognized answer → zero effects", async () => {
    const fileContent = makeFileContent(OPEN_TASK_LINE);
    const ctx = makeCtx({
      files: { [DEST]: fileContent },
      input: envelope({ answer: "snooze" }), // not one of close/defer/keep
    });
    const effects = await settleStaleAnswer.run(ctx as never);

    expect(effects).toHaveLength(0);
  });
});
