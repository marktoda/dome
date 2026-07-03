// dome.daily.stale-task-warden — unit tests for the schedule-driven overdue
// task warden. The warden emits one QuestionEffect per stale (overdue ≥ 14
// days) task so the owner can decide: close, defer, or keep.
//
// Staleness rule (overdue-only, docs/cohesive/brainstorms/
// 2026-07-02-pruning-pass-design.md §2): a task is stale iff it carries a
// 📅 date that is ≥ STALE_OVERDUE_DAYS before today. Undated tasks are never
// settle-question candidates — no discount, no fallback rule.
//
// "today" comes from ctx.now() — the processor is NOT deterministic.
// Tests inject a fixed `now` so output is a pure function of (snapshot, now).

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
const OVERDUE_14_DATE = "2026-06-01"; // exactly 14 days before today (2026-06-15) — boundary (still overdue)
const OVERDUE_15_DATE = "2026-05-31"; // 15 days before — clearly overdue
const FRESH_DATED_DATE = "2026-06-14"; // 1 day overdue — NOT overdue by 14 days

const ALPHA_PATH = "wiki/projects/alpha.md";
const GAMMA_PATH = "wiki/projects/gamma.md";

// Task (a): overdue by ≥14 days — has a 📅 date 15 days before today
const OVERDUE_TASK_BODY = `Review quarterly plan 📅 ${OVERDUE_15_DATE}`;
const OVERDUE_TASK_ANCHOR = "toverdue1234567";
const OVERDUE_TASK_LINE = `- [ ] ${OVERDUE_TASK_BODY} ^${OVERDUE_TASK_ANCHOR}`;

// Task (c): undated — never a settle-question candidate, regardless of how
// many times it has been surfaced in dailies (no discount, no fallback rule).
const UNDATED_TASK_BODY = "Draft architecture proposal";
const UNDATED_TASK_ANCHOR = "tundated1234567";
const UNDATED_TASK_LINE = `- [ ] #task ${UNDATED_TASK_BODY} ^${UNDATED_TASK_ANCHOR}`;

// Task (d): dated but only 1 day overdue — NOT stale by the overdue rule
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

/**
 * A snapshot with:
 *   (a) alpha.md — overdue-15 task + a slightly-overdue task (1 day — NOT ≥14)
 *   (c) gamma.md — undated task, shown repeatedly in dailies — never stale
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
    // (c): undated task, repeatedly surfaced — must never produce a question
    [GAMMA_PATH]: [
      "# Gamma project",
      "",
      UNDATED_TASK_LINE,
      "",
    ].join("\n"),
    // Several dailies showing the undated task repeatedly — under the old
    // attention-discount rule this would have crossed the discount
    // threshold; overdue-only staleness must ignore that entirely.
    "wiki/dailies/2026-06-10.md": dailyWithLoops("2026-06-10", [undatedCopy()]),
    "wiki/dailies/2026-06-11.md": dailyWithLoops("2026-06-11", [undatedCopy()]),
    "wiki/dailies/2026-06-12.md": dailyWithLoops("2026-06-12", [undatedCopy()]),
    "wiki/dailies/2026-06-13.md": dailyWithLoops("2026-06-13", [undatedCopy()]),
    "wiki/dailies/2026-06-14.md": dailyWithLoops("2026-06-14", [undatedCopy()]),
    "wiki/dailies/2026-06-15.md": dailyWithLoops("2026-06-15", [undatedCopy()]),
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

function undatedCopy(body = UNDATED_TASK_BODY): string {
  return `- [ ] ${body} (from [[${GAMMA_PATH.replace(/\.md$/, "")}]])`;
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
  test("emits exactly one settle-stale question: the overdue task", async () => {
    const effects = await runWarden();
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]!.idempotencyKey).toStartWith(SETTLE_STALE_KEY_PREFIX);
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
    const overdueQ = questions.find((q) => q.question.includes(OVERDUE_15_DATE));
    expect(overdueQ).toBeDefined();
    expect(overdueQ!.question).toInclude(ALPHA_PATH);
    // idempotencyKey encodes the stableId for the overdue task (anchor-based)
    const expectedKey = `${SETTLE_STALE_KEY_PREFIX}dome.daily.open-loop:${OVERDUE_TASK_ANCHOR}`;
    expect(overdueQ!.idempotencyKey).toBe(expectedKey);
    // metadata.destination = source path
    expect(overdueQ!.metadata?.destination).toBe(ALPHA_PATH);
  });

  test("undated task NEVER produces a settle-stale question, no matter how many times it is shown", async () => {
    const effects = await runWarden();
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    const undatedQ = questions.find((q) => q.question.includes(UNDATED_TASK_BODY));
    expect(undatedQ).toBeUndefined();
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

  test("15-days-overdue task alone (no other candidates) → exactly one question", async () => {
    const files: Record<string, string> = {
      "wiki/projects/solo.md": `# Solo\n\n- [ ] Solo overdue task 📅 ${OVERDUE_15_DATE} ^tsolo123456789a\n`,
      "wiki/dailies/2026-06-15.md": dailyWithLoops("2026-06-15", []),
    };
    const snapshot = Object.freeze({
      commit: HEAD_COMMIT,
      tree: treeOid("cccccccccccccccccccccccccccccccccccccccc"),
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
    expect(questions).toHaveLength(1);
    expect(questions[0]!.question).toInclude("15 days overdue");
  });

  test("🔺-priority overdue task is still stale — priority does not exempt from the overdue rule", async () => {
    const priorityOverdueBody = `Top priority task 🔺 📅 ${OVERDUE_15_DATE}`;
    const priorityAnchor = "tpriority123456";
    const files: Record<string, string> = {
      "wiki/projects/priority.md": `# Priority\n\n- [ ] ${priorityOverdueBody} ^${priorityAnchor}\n`,
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

  test("unanchored stale overdue task emits NO question (unactionable without anchor)", async () => {
    // A task without a ^anchor is not yet stamped (stamp-block-id runs on the
    // next cycle); it will become eligible once anchored.
    const unanchoredBody = `Unanchored overdue task 📅 ${OVERDUE_15_DATE}`;
    const files: Record<string, string> = {
      "wiki/projects/unanchored.md": `# Unanchored\n\n- [ ] ${unanchoredBody}\n`,
      "wiki/dailies/2026-06-15.md": dailyWithLoops("2026-06-15", []),
    };
    const snapshot = Object.freeze({
      commit: HEAD_COMMIT,
      tree: treeOid("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
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
    // No question: the task has no anchor so the answer handler cannot act on it.
    expect(questions).toHaveLength(0);
  });

  test("same task WITH an anchor emits one question", async () => {
    // Once anchored, the same task becomes eligible for a settle-stale question.
    const anchoredBody = `Anchored overdue task 📅 ${OVERDUE_15_DATE}`;
    const anchoredAnchor = "tanchor12345678";
    const files: Record<string, string> = {
      "wiki/projects/anchored.md": `# Anchored\n\n- [ ] ${anchoredBody} ^${anchoredAnchor}\n`,
      "wiki/dailies/2026-06-15.md": dailyWithLoops("2026-06-15", []),
    };
    const snapshot = Object.freeze({
      commit: HEAD_COMMIT,
      tree: treeOid("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
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
    expect(questions).toHaveLength(1);
    expect(questions[0]!.question).toContain(anchoredBody);
    expect(questions[0]!.metadata?.material).toBe(anchoredAnchor);
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

    // anchor is carried in material so settle-stale-answer can locate the
    // origin line via `^${anchor}` in metadata.destination.
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
