// dome.daily.stale-task-warden — unit tests for the schedule-driven stale/overdue
// task warden. The warden emits one QuestionEffect per stale task so the owner
// can decide: close, defer, or keep.
//
// Staleness rule (OR, not AND):
//   (a) Overdue: task has a 📅 date that is ≥ STALE_OVERDUE_DAYS before today.
//   (b) Discounted: undated task with attention.discount ≥ ATTENTION_STALE_THRESHOLD.
//
// "today" comes from ctx.now() — the processor is NOT deterministic.
// Tests inject a fixed `now` so output is a pure function of (snapshot, now).
//
// Pattern mirrors tests/extensions/attention-discount.test.ts:
// fakeSnapshot + makeProcessorContext, inspect QuestionEffects.

import { describe, expect, test } from "bun:test";

import staleTaskWarden, {
  MAX_SETTLE_STALE,
} from "../../../assets/extensions/dome.daily/processors/stale-task-warden";
import type { QuestionEffect } from "../../../src/core/effect";
import { treeOid, type Snapshot } from "../../../src/core/processor";
import { makeManualProposal } from "../../../src/core/proposal";
import { commitOid } from "../../../src/core/source-ref";
import { makeProcessorContext } from "../../../src/processors/context";

// ---------------------------------------------------------------------------
// Constants mirrored from the processor (to keep tests independent)
// ---------------------------------------------------------------------------

const SETTLE_STALE_KEY_PREFIX = "dome.daily.settle-stale:";
const SETTLE_STALE_OPTIONS = ["close", "defer", "keep"] as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEAD_COMMIT = commitOid("1111111111111111111111111111111111111111");

// Fixed "today" — 2026-06-15. Overdue-14 boundary is 2026-06-01.
const NOW = new Date("2026-06-15T08:00:00.000Z");
const TODAY = "2026-06-15";
const OVERDUE_14_DATE = "2026-06-01"; // exactly 14 days before today — boundary (still overdue)
const OVERDUE_15_DATE = "2026-05-31"; // 15 days before — clearly overdue
const FRESH_DATED_DATE = "2026-06-14"; // 1 day overdue — NOT overdue by 14 days

const ALPHA_PATH = "wiki/projects/alpha.md";
const BETA_PATH = "wiki/projects/beta.md";
const GAMMA_PATH = "wiki/projects/gamma.md";

// Task (a): overdue by ≥14 days — has a 📅 date 15 days before today
const OVERDUE_TASK_BODY = `Review quarterly plan 📅 ${OVERDUE_15_DATE}`;
const OVERDUE_TASK_ANCHOR = "toverdue1234567";
const OVERDUE_TASK_LINE = `- [ ] ${OVERDUE_TASK_BODY} ^${OVERDUE_TASK_ANCHOR}`;

// Task (b): undated + discounted ≥ 0.4
// Shown 6x in dailies → discount = 0.4 (6 impressions: 6-2=4 × 0.1 = 0.4)
// Must use #task so openLoopSurfaceSources picks it up for non-daily files.
// Body after semantic normalization (strip #task prefix): "Draft architecture proposal".
// Daily copies omit the #task marker — they are raw carry-forward copies.
const DISCOUNTED_TASK_BODY = "Draft architecture proposal";
const DISCOUNTED_TASK_ANCHOR = "tdiscounted1234";
const DISCOUNTED_TASK_LINE = `- [ ] #task ${DISCOUNTED_TASK_BODY} ^${DISCOUNTED_TASK_ANCHOR}`;

// Task (c): fresh — undated, low discount (below threshold)
// Must use #task to be surface-eligible.
const FRESH_TASK_BODY = "Add unit tests for parser";
const FRESH_TASK_ANCHOR = "tfresh12345678a";
const FRESH_TASK_LINE = `- [ ] #task ${FRESH_TASK_BODY} ^${FRESH_TASK_ANCHOR}`;

// Task (d): dated but only 1 day overdue — NOT stale by rule (a)
const SLIGHTLY_OVERDUE_BODY = `Quick review 📅 ${FRESH_DATED_DATE}`;
const SLIGHTLY_OVERDUE_ANCHOR = "tslightly12345a";
const SLIGHTLY_OVERDUE_LINE = `- [ ] ${SLIGHTLY_OVERDUE_BODY} ^${SLIGHTLY_OVERDUE_ANCHOR}`;

function dailyWithLoops(date: string, copies: ReadonlyArray<string>): string {
  return [
    `# ${date}`,
    "",
    "## Open Loops",
    "",
    "<!-- dome.daily:open-loops:start -->",
    "### Source-backed Open Loops",
    ...copies,
    "<!-- dome.daily:open-loops:end -->",
    "",
  ].join("\n");
}

function discountedCopy(body = DISCOUNTED_TASK_BODY): string {
  return `- [ ] ${body} (from [[${BETA_PATH.replace(/\.md$/, "")}]])`;
}

/**
 * A snapshot with:
 *   (a) alpha.md — overdue-14 task
 *   (b) beta.md — undated task shown 6x (discount ≥ 0.4)
 *   (c) gamma.md — fresh undated task (shown only once — below threshold)
 *   (d) alpha.md also has a slightly-overdue task (1 day — NOT ≥14)
 * Plus 6 dailies showing the discounted task (b) and 1 showing fresh (c).
 */
function makeFixtureSnapshot(): Snapshot {
  const files: Record<string, string> = {
    // (a) + (d): overdue task + slightly overdue task
    [ALPHA_PATH]: [
      "# Alpha project",
      "",
      OVERDUE_TASK_LINE,
      SLIGHTLY_OVERDUE_LINE,
      "",
    ].join("\n"),
    // (b): undated task to be discounted
    [BETA_PATH]: [
      "# Beta project",
      "",
      DISCOUNTED_TASK_LINE,
      "",
    ].join("\n"),
    // (c): fresh undated task
    [GAMMA_PATH]: [
      "# Gamma project",
      "",
      FRESH_TASK_LINE,
      "",
    ].join("\n"),
    // 6 dailies showing beta task, including the reference (newest) daily 2026-06-15
    // so daysSinceLastShown = 0 → discount = 0.4 exactly (≥ threshold).
    // Formula: base = min(0.6, 0.1 * (6-2)) = 0.4; decayed = 0.4 * 0.9^0 = 0.4.
    "wiki/dailies/2026-06-10.md": dailyWithLoops("2026-06-10", [discountedCopy()]),
    "wiki/dailies/2026-06-11.md": dailyWithLoops("2026-06-11", [discountedCopy()]),
    "wiki/dailies/2026-06-12.md": dailyWithLoops("2026-06-12", [discountedCopy()]),
    "wiki/dailies/2026-06-13.md": dailyWithLoops("2026-06-13", [discountedCopy()]),
    "wiki/dailies/2026-06-14.md": dailyWithLoops("2026-06-14", [discountedCopy()]),
    // Reference daily (2026-06-15): shows beta task → 6th impression, lastShown = today
    // Also shows fresh (gamma) task once — only 1 impression → discount 0 (below threshold)
    "wiki/dailies/2026-06-15.md": dailyWithLoops("2026-06-15", [
      discountedCopy(),
      `- [ ] ${FRESH_TASK_BODY} (from [[${GAMMA_PATH.replace(/\.md$/, "")}]])`,
    ]),
  };

  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("2222222222222222222222222222222222222222"),
    readFile: async (p: string) => files[p] ?? null,
    listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
    getFileInfo: async (p: string) => {
      if (!(p in files)) return null;
      return Object.freeze({
        lastChangedCommit: HEAD_COMMIT,
        lastChangedAt: "2026-06-09T10:00:00.000Z",
        lastHumanChangedAt: null,
      });
    },
  });
}

async function runWarden(snapshot: Snapshot = makeFixtureSnapshot()) {
  const ctx = makeProcessorContext({
    snapshot,
    changedPaths: [],
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-stale-task-warden",
    signal: new AbortController().signal,
    now: NOW,
    input: { kind: "garden", matchedTriggers: [] } as unknown,
  });
  return staleTaskWarden.run(ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dome.daily.stale-task-warden", () => {
  test("emits exactly two settle-stale questions: one for overdue task, one for discounted task", async () => {
    const effects = await runWarden();
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    expect(questions).toHaveLength(2);

    const keys = questions.map((q) => q.idempotencyKey);
    // Both keys must start with the prefix
    for (const key of keys) {
      expect(key).toStartWith(SETTLE_STALE_KEY_PREFIX);
    }
  });

  test("each question has options [close, defer, keep]", async () => {
    const effects = await runWarden();
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    for (const q of questions) {
      expect(q.options).toEqual([...SETTLE_STALE_OPTIONS]);
    }
  });

  test("each question has automationPolicy: owner-needed", async () => {
    const effects = await runWarden();
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    for (const q of questions) {
      expect(q.metadata?.automationPolicy).toBe("owner-needed");
    }
  });

  test("overdue task question includes the source path and due date", async () => {
    const effects = await runWarden();
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    // The overdue task's question should mention alpha.md and the due date
    const overdueQ = questions.find((q) => q.question.includes(OVERDUE_15_DATE));
    expect(overdueQ).toBeDefined();
    expect(overdueQ!.question).toInclude(ALPHA_PATH);
    // idempotencyKey encodes the stableId for the overdue task (anchor-based)
    const expectedKey = `${SETTLE_STALE_KEY_PREFIX}dome.daily.open-loop:${OVERDUE_TASK_ANCHOR}`;
    expect(overdueQ!.idempotencyKey).toBe(expectedKey);
    // metadata.destination = source path
    expect(overdueQ!.metadata?.destination).toBe(ALPHA_PATH);
  });

  test("discounted task question includes the source path", async () => {
    const effects = await runWarden();
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    const discountedQ = questions.find((q) =>
      q.question.includes(DISCOUNTED_TASK_BODY),
    );
    expect(discountedQ).toBeDefined();
    expect(discountedQ!.question).toInclude(BETA_PATH);
    const expectedKey = `${SETTLE_STALE_KEY_PREFIX}dome.daily.open-loop:${DISCOUNTED_TASK_ANCHOR}`;
    expect(discountedQ!.idempotencyKey).toBe(expectedKey);
    expect(discountedQ!.metadata?.destination).toBe(BETA_PATH);
  });

  test("no question for fresh task (gamma) — too little discount", async () => {
    const effects = await runWarden();
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    const freshQ = questions.find((q) => q.question.includes(FRESH_TASK_BODY));
    expect(freshQ).toBeUndefined();
  });

  test("no question for slightly-overdue task (< 14 days overdue)", async () => {
    const effects = await runWarden();
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    const slightQ = questions.find((q) =>
      q.question.includes(SLIGHTLY_OVERDUE_BODY.slice(0, 20)) ||
      q.question.includes(FRESH_DATED_DATE),
    );
    expect(slightQ).toBeUndefined();
  });

  test("boundary: task overdue exactly 14 days IS stale", async () => {
    // alpha.md with a task dated exactly 14 days ago (2026-06-01 when today=2026-06-15)
    const boundaryBody = `Boundary task 📅 ${OVERDUE_14_DATE}`;
    const boundaryAnchor = "tboundary12345a";
    const files: Record<string, string> = {
      "wiki/projects/boundary.md": `# Boundary\n\n- [ ] ${boundaryBody} ^${boundaryAnchor}\n`,
      "wiki/dailies/2026-06-15.md": dailyWithLoops("2026-06-15", []),
    };
    const snapshot = Object.freeze({
      commit: HEAD_COMMIT,
      tree: treeOid("3333333333333333333333333333333333333333"),
      readFile: async (p: string) => files[p] ?? null,
      listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
      getFileInfo: async (p: string) => {
        if (!(p in files)) return null;
        return Object.freeze({
          lastChangedCommit: HEAD_COMMIT,
          lastChangedAt: "2026-06-01T10:00:00.000Z",
          lastHumanChangedAt: null,
        });
      },
    });

    const effects = await runWarden(snapshot);
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]!.question).toInclude(OVERDUE_14_DATE);
  });

  test("boundary: task overdue exactly 13 days is NOT stale", async () => {
    // 13 days overdue = 2026-06-02 when today = 2026-06-15
    const notYetStaleDate = "2026-06-02";
    const files: Record<string, string> = {
      "wiki/projects/recent.md": `# Recent\n\n- [ ] Recent task 📅 ${notYetStaleDate} ^trecent1234567a\n`,
      "wiki/dailies/2026-06-15.md": dailyWithLoops("2026-06-15", []),
    };
    const snapshot = Object.freeze({
      commit: HEAD_COMMIT,
      tree: treeOid("4444444444444444444444444444444444444444"),
      readFile: async (p: string) => files[p] ?? null,
      listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
      getFileInfo: async (p: string) => {
        if (!(p in files)) return null;
        return Object.freeze({
          lastChangedCommit: HEAD_COMMIT,
          lastChangedAt: "2026-06-02T10:00:00.000Z",
          lastHumanChangedAt: null,
        });
      },
    });

    const effects = await runWarden(snapshot);
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    expect(questions).toHaveLength(0);
  });

  test("exempt dated tasks are exempt from discount but overdue rule still applies", async () => {
    // A 🔺-priority dated overdue task: exempt from discount (discount=0),
    // but the overdue rule is purely date-based, so it should still be stale.
    const exemptOverdueBody = `Top priority task 🔺 📅 ${OVERDUE_15_DATE}`;
    const exemptAnchor = "texempt12345678";
    const files: Record<string, string> = {
      "wiki/projects/exempt.md": `# Exempt\n\n- [ ] ${exemptOverdueBody} ^${exemptAnchor}\n`,
      "wiki/dailies/2026-06-15.md": dailyWithLoops("2026-06-15", []),
    };
    const snapshot = Object.freeze({
      commit: HEAD_COMMIT,
      tree: treeOid("5555555555555555555555555555555555555555"),
      readFile: async (p: string) => files[p] ?? null,
      listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
      getFileInfo: async (p: string) => {
        if (!(p in files)) return null;
        return Object.freeze({
          lastChangedCommit: HEAD_COMMIT,
          lastChangedAt: "2026-04-01T10:00:00.000Z",
          lastHumanChangedAt: null,
        });
      },
    });

    const effects = await runWarden(snapshot);
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    // Overdue rule applies regardless of priority/exempt — 🔺 exempts from
    // discount but NOT from the overdue date check.
    expect(questions).toHaveLength(1);
  });

  test("idempotent: same snapshot + now → same questions", async () => {
    const first = await runWarden();
    const second = await runWarden();
    expect(second).toEqual(first);
  });

  test("empty vault → no questions", async () => {
    const emptySnapshot = Object.freeze({
      commit: HEAD_COMMIT,
      tree: treeOid("6666666666666666666666666666666666666666"),
      readFile: async () => null,
      listMarkdownFiles: async () => Object.freeze([]) as ReadonlyArray<string>,
      getFileInfo: async () => null,
    });
    const effects = await runWarden(emptySnapshot);
    expect(effects.filter((e): e is QuestionEffect => e.kind === "question")).toHaveLength(0);
  });

  test("cap: > MAX_SETTLE_STALE stale tasks → exactly MAX_SETTLE_STALE questions, worst first", async () => {
    // Build 10 overdue tasks all clearly stale (14–23 days overdue), all above
    // STALE_OVERDUE_DAYS = 14. Expectation: only the top 8 (most-overdue) are
    // emitted, i.e. the 16–23d ones; 14d and 15d are cut off.
    const TASK_COUNT = 10;
    const tasks: Array<{ anchor: string; daysOverdue: number }> = [];
    for (let i = 0; i < TASK_COUNT; i++) {
      tasks.push({
        anchor: `tcap${String(i).padStart(11, "0")}`,
        // 23, 22, 21, ..., 14 days overdue (all ≥ STALE_OVERDUE_DAYS)
        daysOverdue: 23 - i,
      });
    }

    // Each task gets its own project file to avoid any carry-forward confusion.
    const files: Record<string, string> = {
      "wiki/dailies/2026-06-15.md": dailyWithLoops("2026-06-15", []),
    };
    for (const task of tasks) {
      const dueDate = wholeDaysBeforeToday(task.daysOverdue);
      const body = `Cap test task ${task.daysOverdue}d overdue \u{1F4C5} ${dueDate}`;
      files[`wiki/projects/cap-task-${task.daysOverdue}.md`] = [
        "# Cap test",
        "",
        `- [ ] ${body} ^${task.anchor}`,
        "",
      ].join("\n");
    }

    const snapshot = Object.freeze({
      commit: HEAD_COMMIT,
      tree: treeOid("7777777777777777777777777777777777777777"),
      readFile: async (p: string) => files[p] ?? null,
      listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
      getFileInfo: async (p: string) => {
        if (!(p in files)) return null;
        return Object.freeze({
          lastChangedCommit: HEAD_COMMIT,
          lastChangedAt: "2026-05-01T10:00:00.000Z",
          lastHumanChangedAt: null,
        });
      },
    });

    const effects = await runWarden(snapshot);
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );

    // Exactly MAX_SETTLE_STALE (8) questions despite 10 stale tasks.
    expect(questions).toHaveLength(MAX_SETTLE_STALE);

    // The emitted questions must be the 8 MOST overdue (daysOverdue 16..23).
    // daysOverdue 14 and 15 are cut off.
    const emittedTexts = questions.map((q) => q.question);
    for (let daysOverdue = 16; daysOverdue <= 23; daysOverdue++) {
      expect(emittedTexts.some((t) => t.includes(`${daysOverdue}d overdue`))).toBe(true);
    }
    // The two least-stale (14d, 15d) must NOT appear.
    expect(emittedTexts.some((t) => t.includes("14d overdue"))).toBe(false);
    expect(emittedTexts.some((t) => t.includes("15d overdue"))).toBe(false);

    // Questions are ordered worst-first: most-overdue first.
    for (let i = 0; i < questions.length - 1; i++) {
      const a = questions[i]!;
      const b = questions[i + 1]!;
      // Extract days-overdue number from question text ("N days overdue")
      const aDays = Number(/(\d+) days overdue/.exec(a.question)?.[1]);
      const bDays = Number(/(\d+) days overdue/.exec(b.question)?.[1]);
      expect(aDays).toBeGreaterThanOrEqual(bDays);
    }
  });

  test("metadata: anchor is in material and recommendedAnswer is 'keep' for anchored task", async () => {
    // The overdue task in the fixture has OVERDUE_TASK_ANCHOR — verify it round-trips.
    const effects = await runWarden();
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    const overdueQ = questions.find((q) => q.question.includes(OVERDUE_15_DATE));
    expect(overdueQ).toBeDefined();

    // recommendedAnswer defaults to "keep" (bias toward not auto-disrupting).
    expect(overdueQ!.metadata?.recommendedAnswer).toBe("keep");

    // anchor is carried in material so Task 2 (settle-stale-answer) can locate
    // the origin line via `^${anchor}` in metadata.destination.
    expect(overdueQ!.metadata?.material).toBe(OVERDUE_TASK_ANCHOR);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Return the YYYY-MM-DD date string that is `n` whole days before TODAY (2026-06-15).
 */
function wholeDaysBeforeToday(n: number): string {
  const baseMs = Date.parse("2026-06-15T00:00:00.000Z");
  const targetMs = baseMs - n * 86_400_000;
  return new Date(targetMs).toISOString().slice(0, 10);
}
