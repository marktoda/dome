// dome.health.report-card — the weekly garden report (Task 11).
//
// The deterministic garden processor renders two surfaces from the run ledger
// + question rows over the trailing 7 days: the full `meta/report-card.md`
// card and the `dome.health:report-card` daily block under `## Weekly review`,
// in ONE PatchEffect. Byte-identical re-render emits no patch; a missing run
// view is LOUD and skips the write; the retrieval-miss row renders only when
// the misses file exists. Productive = a run that reached `succeeded`.

import { describe, expect, test } from "bun:test";

import reportCard from "../../../assets/extensions/dome.health/processors/report-card";
import {
  aggregateQuestionStats,
  aggregateRunStats,
  countRetrievalMisses,
  possiblyIdle,
  REPORT_CARD_PATH,
  RETRIEVAL_MISSES_PATH,
} from "../../../assets/extensions/dome.health/processors/report-card-render";
import {
  dailyPath,
  dailyPathSettings,
  formatDate,
  localDateParts,
} from "../../../assets/extensions/dome.daily/processors/daily-paths";
import type { DiagnosticEffect, PatchEffect } from "../../../src/core/effect";
import { commitOid, type CommitOid } from "../../../src/core/source-ref";
import {
  treeOid,
  type OperationalProposalRow,
  type OperationalQueryView,
  type OperationalRunRow,
  type OperationalQuestionRow,
  type Snapshot,
} from "../../../src/core/processor";
import { CONFIG_PATH } from "../../../assets/extensions/dome.health/processors/trust-review-shared";
import { makeProcessorContext } from "../../../src/processors/context";

const HEAD_COMMIT = commitOid("8888888888888888888888888888888888888888");
const TREE = treeOid("9999999999999999999999999999999999999999");
const ADOPTED: CommitOid = commitOid(
  "7777777777777777777777777777777777777777",
);

// The card fires Monday 05:22 vault-LOCAL; build the fire time from local
// components so the derived window-end date is TZ-robust. 2026-06-01 is a Mon.
const FIRED_AT = new Date(2026, 5, 1, 5, 22).toISOString();
const SETTINGS = dailyPathSettings(undefined);
const TODAY = localDateParts(new Date(FIRED_AT));
const TODAY_STR = formatDate(TODAY);
const TODAY_PATH = dailyPath(TODAY, SETTINGS);

const BLOCK_START = "<!-- dome.health:report-card:start -->";
const BLOCK_END = "<!-- dome.health:report-card:end -->";

const QUARANTINE_ERROR = JSON.stringify({ code: "processor.quarantined" });

describe("report-card renderers (pure)", () => {
  test("aggregateRunStats: runs / failures / quarantines / cost / productive", () => {
    const stats = aggregateRunStats([
      run({ processorId: "dome.b", status: "succeeded", costUsd: 0.5 }),
      run({ processorId: "dome.b", status: "succeeded", costUsd: 0.25 }),
      run({ processorId: "dome.b", status: "failed" }),
      run({ processorId: "dome.a", status: "timed_out" }),
      run({ processorId: "dome.a", status: "skipped", error: QUARANTINE_ERROR }),
      run({ processorId: "dome.a", status: "skipped", error: '{"code":"other"}' }),
    ]);
    // Sorted by processorId ascending.
    expect(stats.map((s) => s.processorId)).toEqual(["dome.a", "dome.b"]);
    const a = stats[0]!;
    expect(a).toMatchObject({ runs: 3, failures: 1, quarantines: 1, productive: 0 });
    const b = stats[1]!;
    expect(b).toMatchObject({ runs: 3, failures: 1, productive: 2 });
    expect(b.costUsd).toBeCloseTo(0.75);
  });

  test("a succeeded zero-effect run is a no-op — counted as a run, NOT productive", () => {
    const stats = aggregateRunStats([
      run({ processorId: "dome.noop", status: "succeeded", effectCount: 0 }),
      run({ processorId: "dome.noop", status: "succeeded", effectCount: 0 }),
      run({ processorId: "dome.noop", status: "succeeded", effectCount: 2 }),
    ]);
    expect(stats).toEqual([
      {
        processorId: "dome.noop",
        runs: 3,
        failures: 0,
        quarantines: 0,
        costUsd: 0,
        productive: 1,
      },
    ]);
  });

  test("possiblyIdle: ≥50 runs and zero productive", () => {
    const idle = possiblyIdle([
      { processorId: "dome.busy", runs: 60, failures: 60, quarantines: 0, costUsd: 0, productive: 0 },
      { processorId: "dome.ok", runs: 60, failures: 0, quarantines: 0, costUsd: 0, productive: 60 },
      { processorId: "dome.small", runs: 10, failures: 10, quarantines: 0, costUsd: 0, productive: 0 },
    ]);
    expect(idle.map((s) => s.processorId)).toEqual(["dome.busy"]);
  });

  test("aggregateQuestionStats: opened/resolved in window, all-zero dropped", () => {
    const windowStart = "2026-05-25T00:00:00.000Z";
    const stats = aggregateQuestionStats(
      [
        q({ processorId: "dome.q", askedAt: "2026-05-30T00:00:00.000Z" }),
        q({
          processorId: "dome.q",
          askedAt: "2026-05-01T00:00:00.000Z", // opened before window
          answeredAt: "2026-05-30T00:00:00.000Z",
          state: "resolved",
        }),
        q({ processorId: "dome.old", askedAt: "2026-05-01T00:00:00.000Z" }), // all outside
      ],
      windowStart,
    );
    expect(stats).toEqual([
      { processorId: "dome.q", opened: 1, resolved: 1 },
    ]);
  });

  test("countRetrievalMisses: only date-prefixed bullets within the window", () => {
    const content = [
      "# Retrieval misses",
      '- 2026-06-01 — "where is the alpha spec" — no hit',
      '- 2026-05-28 — "beta pricing" — stale',
      '- 2026-05-20 — "gamma" — outside the window',
      'not a bullet 2026-06-01',
      '- freeform note without a date',
    ].join("\n");
    const window = new Set(["2026-06-01", "2026-05-28", "2026-05-27"]);
    expect(countRetrievalMisses(content, window)).toBe(2);
  });
});

describe("dome.health.report-card (processor run path)", () => {
  test("emits ONE patch covering both files with the expected content", async () => {
    const { patch, card, daily } = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      {
        runs: [
          run({ processorId: "dome.agent.brief", status: "succeeded", costUsd: 1.2 }),
          run({ processorId: "dome.agent.brief", status: "succeeded", costUsd: 0.8 }),
          run({ processorId: "dome.daily.compose-blocks", status: "succeeded" }),
          run({ processorId: "dome.daily.compose-blocks", status: "failed" }),
        ],
        questions: [
          q({ processorId: "dome.daily.task-index", askedAt: "2026-05-30T00:00:00.000Z" }),
          q({
            processorId: "dome.daily.task-index",
            askedAt: "2026-05-28T00:00:00.000Z",
            answeredAt: "2026-05-31T00:00:00.000Z",
            state: "resolved",
          }),
        ],
      },
    );
    expect(patch).toBeDefined();
    // ONE patch, both files, report-card first.
    expect(patch!.changes.map((c) => String(c.path))).toEqual([
      REPORT_CARD_PATH,
      TODAY_PATH,
    ]);

    // Full card: the per-processor table + questions + productive counts.
    expect(card).toContain("# Weekly report card");
    expect(card).toContain("| dome.agent.brief | 2 | 0 | 0 | 2.00 | 2 |");
    expect(card).toContain("| dome.daily.compose-blocks | 2 | 1 | 0 | 0.00 | 1 |");
    expect(card).toContain("| dome.daily.task-index | 2 | 1 |");
    // No misses file → no misses section.
    expect(card).not.toContain("## Retrieval misses");
    // Possibly-idle empty → None.
    expect(card).toContain("## Possibly idle");
    expect(card).toContain("_None._");

    // Daily block: total cost, top spenders, questions, full-card link.
    expect(daily).toContain(BLOCK_START);
    expect(daily).toContain("### Report card");
    expect(daily).toContain("- Model cost (7d): $2.00");
    expect(daily).toContain("dome.agent.brief $2.00 (2 productive)");
    expect(daily).toContain("- Questions: 2 opened / 1 resolved");
    expect(daily).toContain("- Full card: [[meta/report-card]]");
    // No misses file → no misses line in the block.
    expect(daily).not.toContain("Retrieval misses:");
    // Plain bullets only — never checkboxes.
    expect(blockBody(daily)).not.toContain("- [ ]");
    // The block lands under ## Weekly review.
    expect(daily).toContain("## Weekly review");
  });

  test("possibly-idle: a busy-but-unproductive processor is listed", async () => {
    const runs = Array.from({ length: 55 }, () =>
      run({ processorId: "dome.lint.spin", status: "failed" }),
    );
    const { card } = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      { runs, questions: [] },
    );
    expect(card).toContain(
      "- dome.lint.spin — 55 runs, 0 productive outcomes",
    );
  });

  test("possibly-idle: ≥50 SUCCEEDED no-op runs (zero effects) DOES flag idle", async () => {
    // The dominant live-vault case: a deterministic indexer that succeeds on
    // every fire while emitting nothing. Succeeding is not producing.
    const runs = Array.from({ length: 60 }, () =>
      run({ processorId: "dome.graph.indexer", status: "succeeded", effectCount: 0 }),
    );
    const { card } = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      { runs, questions: [] },
    );
    expect(card).toContain("| dome.graph.indexer | 60 | 0 | 0 | 0.00 | 0 |");
    expect(card).toContain(
      "- dome.graph.indexer — 60 runs, 0 productive outcomes",
    );
    expect(card).not.toContain("_None._");
  });

  test("absent misses file omits the row; present file counts and renders it", async () => {
    const withoutFile = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      { runs: [run({ processorId: "dome.x", status: "succeeded" })], questions: [] },
    );
    expect(withoutFile.card).not.toContain("## Retrieval misses");
    expect(withoutFile.daily).not.toContain("Retrieval misses:");

    const misses = [
      "# Retrieval misses",
      '- 2026-06-01 — "alpha" — no hit',
      '- 2026-05-30 — "beta" — no hit',
      '- 2026-04-01 — "way outside window" — old',
    ].join("\n");
    const withFile = await runReportCard(
      {
        [TODAY_PATH]: BASE_DAILY,
        [RETRIEVAL_MISSES_PATH]: misses,
      },
      { runs: [run({ processorId: "dome.x", status: "succeeded" })], questions: [] },
    );
    expect(withFile.card).toContain("## Retrieval misses");
    expect(withFile.card).toContain("_2 retrieval misses logged this week._");
    expect(withFile.daily).toContain("- Retrieval misses: 2");
  });

  test("byte-identical re-render emits no patch (no-op)", async () => {
    const inputs = {
      runs: [
        run({ processorId: "dome.agent.brief", status: "succeeded", costUsd: 1.2 }),
        run({ processorId: "dome.daily.compose-blocks", status: "succeeded" }),
      ],
      questions: [
        q({ processorId: "dome.daily.task-index", askedAt: "2026-05-30T00:00:00.000Z" }),
      ],
    };
    const first = await runReportCard({ [TODAY_PATH]: BASE_DAILY }, inputs);
    expect(first.patch).toBeDefined();

    // Feed BOTH written files back — a second render must be a no-op.
    const second = await runReportCard(
      { [TODAY_PATH]: first.daily!, [REPORT_CARD_PATH]: first.card! },
      inputs,
    );
    expect(second.patch).toBeUndefined();
  });

  test("missing run view is LOUD (warning) and writes nothing", async () => {
    const { patch, diagnostics } = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      undefined, // no operational view
    );
    expect(patch).toBeUndefined();
    const missing = diagnostics.find(
      (d) => d.code === "dome.health.report-card-runs-view-missing",
    );
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("warning");
  });

  test("creates today's daily skeleton when absent (block still lands)", async () => {
    const { patch, daily } = await runReportCard(
      {},
      { runs: [run({ processorId: "dome.x", status: "succeeded" })], questions: [] },
    );
    expect(patch).toBeDefined();
    expect(daily).toContain(`# ${TODAY_STR}`);
    expect(daily).toContain(BLOCK_START);
  });

  // ----- Aging decisions (Task 10) --------------------------------------------

  test("aging: an open question ≥7 days old lists in BOTH the card and the daily block, with a resolve command", async () => {
    const agingQuestion = q({
      processorId: "dome.some.processor",
      askedAt: "2026-05-20T00:00:00.000Z", // 12 days before the 2026-06-01 fire
    });
    const { card, daily } = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      {
        runs: [run({ processorId: "dome.x", status: "succeeded" })],
        questions: [agingQuestion],
      },
    );
    expect(card).toContain("### Aging decisions");
    expect(card).toContain("resolve: `dome resolve 1 <answer>`");
    expect(daily).toContain("### Aging decisions");
    expect(daily).toContain("resolve: `dome resolve 1 <answer>`");
  });

  test("no aging questions: card shows the fallback line, daily block omits the section", async () => {
    const fresh = q({
      processorId: "dome.some.processor",
      askedAt: "2026-05-30T00:00:00.000Z", // 2 days before the fire — fresh
    });
    const { card, daily } = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      {
        runs: [run({ processorId: "dome.x", status: "succeeded" })],
        questions: [fresh],
      },
    );
    expect(card).toContain("### Aging decisions");
    expect(card).toContain("_No aging decisions this week._");
    expect(daily).not.toContain("### Aging decisions");
  });

  test("aging: question_aging_days config is respected (degrade-not-crash)", async () => {
    const fourDaysOld = q({
      processorId: "dome.some.processor",
      askedAt: "2026-05-28T00:00:00.000Z", // 4 days before the fire
    });
    const strict = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      {
        runs: [run({ processorId: "dome.x", status: "succeeded" })],
        questions: [fourDaysOld],
      },
      { question_aging_days: 3 },
    );
    expect(strict.card).not.toContain("_No aging decisions this week._");
    expect(strict.daily).toContain("### Aging decisions");

    // An invalid config value degrades to the default (7 days) rather than
    // crashing — a 4-day-old question stays fresh under the default.
    const degraded = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      {
        runs: [run({ processorId: "dome.x", status: "succeeded" })],
        questions: [fourDaysOld],
      },
      { question_aging_days: "not-a-number" },
    );
    expect(degraded.card).toContain("_No aging decisions this week._");
    expect(degraded.daily).not.toContain("### Aging decisions");
  });
});

describe("report-card trust ladder section", () => {
  const TRUST_CONFIG = [
    "extensions:",
    "  dome.acme:",
    "    enabled: true",
    "    grant:",
    '      read: ["wiki/**/*.md"]',
    '      patch.propose: ["wiki/**/*.md"]',
    "",
  ].join("\n");

  function trustProposal(input: {
    readonly id: number;
    readonly status: "pending" | "applied" | "rejected";
    readonly decidedAt?: string | null;
  }): OperationalProposalRow {
    return Object.freeze({
      id: input.id,
      processorId: "dome.acme.tidy",
      extensionId: "dome.acme",
      reason: "tidy the notes",
      paths: Object.freeze(["wiki/notes/a.md"]),
      createdAt: "2026-05-29T00:00:00.000Z",
      status: input.status,
      decidedAt: input.decidedAt ?? null,
    });
  }

  test("renders per-producer autonomy + decided/applied + accept rate", async () => {
    const { card } = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY, [CONFIG_PATH]: TRUST_CONFIG },
      {
        runs: [run({ processorId: "dome.x", status: "succeeded" })],
        questions: [],
        proposals: [
          trustProposal({ id: 1, status: "applied", decidedAt: "2026-05-30T00:00:00.000Z" }),
          trustProposal({ id: 2, status: "rejected", decidedAt: "2026-05-31T00:00:00.000Z" }),
          trustProposal({ id: 3, status: "pending" }),
        ],
      },
    );
    expect(card).toContain("## Trust ladder");
    expect(card).toContain("| dome.acme.tidy | propose | 2 | 1 | 0.50 |");
  });

  test("autonomy renders 'unknown' when the config is unreadable (degrade, never crash)", async () => {
    const { card } = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY }, // no .dome/config.yaml in the snapshot
      {
        runs: [run({ processorId: "dome.x", status: "succeeded" })],
        questions: [],
        proposals: [
          trustProposal({ id: 1, status: "applied", decidedAt: "2026-05-30T00:00:00.000Z" }),
        ],
      },
    );
    expect(card).toContain("| dome.acme.tidy | unknown | 1 | 1 | 1.00 |");
  });

  test("no proposals in the window renders the fallback line", async () => {
    const { card } = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      { runs: [run({ processorId: "dome.x", status: "succeeded" })], questions: [] },
    );
    expect(card).toContain("## Trust ladder");
    expect(card).toContain("_No proposals in the last 7 days._");
  });

  test("missing proposals view is LOUD (warning) and the section falls back empty", async () => {
    const { card, diagnostics } = await runReportCard(
      { [TODAY_PATH]: BASE_DAILY },
      {
        runs: [run({ processorId: "dome.x", status: "succeeded" })],
        questions: [],
        proposals: null,
      },
    );
    expect(card).toContain("_No proposals in the last 7 days._");
    const missing = diagnostics.find(
      (d) => d.code === "dome.health.report-card-proposals-view-missing",
    );
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("warning");
  });
});

// ----- Fixtures + harness ----------------------------------------------------

const BASE_DAILY = [
  "---",
  "type: daily",
  `created: ${TODAY_STR}`,
  "---",
  "",
  `# ${TODAY_STR}`,
  "",
  "## Start Here",
  "",
  "## Meetings",
  "",
  "## Done",
  "",
].join("\n");

function run(input: {
  readonly processorId: string;
  readonly status: OperationalRunRow["status"];
  readonly costUsd?: number | null;
  readonly error?: string | null;
  /**
   * Defaults mirror the ledger: succeeded runs default to 1 emitted effect
   * (productive), every other status to 0 (markSucceeded is the only effect-
   * hash writer). Pass 0 explicitly to model a succeeded no-op run.
   */
  readonly effectCount?: number;
}): OperationalRunRow {
  return Object.freeze({
    id: `run-${input.processorId}-${Math.random()}`,
    proposalId: null,
    processorId: input.processorId,
    processorVersion: "1.0.0",
    phase: "garden",
    inputCommit: String(ADOPTED),
    outputCommit: null,
    status: input.status,
    costUsd: input.costUsd ?? null,
    durationMs: 100,
    effectCount: input.effectCount ?? (input.status === "succeeded" ? 1 : 0),
    error: input.error ?? null,
    triggerKind: "schedule",
    startedAt: "2026-05-30T00:00:00.000Z",
    finishedAt: "2026-05-30T00:00:01.000Z",
  });
}

function q(input: {
  readonly processorId: string;
  readonly askedAt: string;
  readonly answeredAt?: string | null;
  readonly state?: "open" | "resolved";
}): OperationalQuestionRow {
  return Object.freeze({
    kind: "question",
    question: "stub?",
    sourceRefs: Object.freeze([]),
    idempotencyKey: `test:${input.processorId}:${input.askedAt}`,
    metadata: Object.freeze({}),
    id: 1,
    processorId: input.processorId,
    runId: "run-x",
    adoptedCommit: ADOPTED,
    askedAt: input.askedAt,
    answeredAt: input.answeredAt ?? null,
    answer: null,
    state: input.state ?? "open",
  }) as OperationalQuestionRow;
}

function viewOf(inputs: {
  readonly runs: ReadonlyArray<OperationalRunRow>;
  readonly questions: ReadonlyArray<OperationalQuestionRow>;
  /** `null` models a missing proposals view (proposals.read ungranted). */
  readonly proposals?: ReadonlyArray<OperationalProposalRow> | null;
}): OperationalQueryView {
  const proposals = inputs.proposals === undefined ? [] : inputs.proposals;
  return Object.freeze({
    outbox: () => Object.freeze([]),
    quarantines: () => Object.freeze([]),
    orphanRuns: () => Object.freeze([]),
    runs: () => Object.freeze([...inputs.runs]),
    questions: () => Object.freeze([...inputs.questions]),
    ...(proposals !== null
      ? { proposals: () => Object.freeze([...proposals]) }
      : {}),
  });
}

async function runReportCard(
  files: Readonly<Record<string, string>>,
  inputs:
    | {
        readonly runs: ReadonlyArray<OperationalRunRow>;
        readonly questions: ReadonlyArray<OperationalQuestionRow>;
        readonly proposals?: ReadonlyArray<OperationalProposalRow> | null;
      }
    | undefined,
  extensionConfig?: Readonly<Record<string, unknown>>,
): Promise<{
  readonly patch: PatchEffect | undefined;
  readonly card: string | null;
  readonly daily: string | null;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
}> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(files),
    changedPaths: [],
    proposal: null,
    runId: "run-report-card",
    signal: new AbortController().signal,
    now: new Date(FIRED_AT),
    input: { kind: "schedule", cron: "22 5 * * 1", firedAt: FIRED_AT },
    ...(inputs !== undefined ? { operational: viewOf(inputs) } : {}),
    ...(extensionConfig !== undefined ? { extensionConfig } : {}),
  });
  const effects = await reportCard.run(ctx);
  const patch = effects.find(
    (effect): effect is PatchEffect => effect.kind === "patch",
  );
  const diagnostics = effects.filter(
    (effect): effect is DiagnosticEffect => effect.kind === "diagnostic",
  );
  const cardChange = patch?.changes.find(
    (c) => String(c.path) === REPORT_CARD_PATH,
  );
  const dailyChange = patch?.changes.find((c) => String(c.path) === TODAY_PATH);
  return {
    patch,
    card: cardChange?.kind === "write" ? cardChange.content : null,
    daily: dailyChange?.kind === "write" ? dailyChange.content : null,
    diagnostics,
  };
}

function blockBody(content: string | null): string {
  if (content === null) return "";
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start < 0 || end < 0) return "";
  return content.slice(start, end);
}

function fakeSnapshot(files: Readonly<Record<string, string>>): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: TREE,
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () =>
      Object.freeze(Object.keys(files).filter((path) => path.endsWith(".md"))),
    getFileInfo: async (path: string) =>
      files[path] === undefined
        ? null
        : {
            lastChangedCommit: HEAD_COMMIT,
            lastChangedAt: "2026-06-01T05:00:00.000Z",
            lastHumanChangedAt: "2026-06-01T05:00:00.000Z",
          },
  });
}
