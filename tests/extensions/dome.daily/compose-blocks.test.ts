// dome.daily.compose-blocks — the deterministic compositor (D6/compiled-daily).
//
// At 05:25 (and on `questions.changed` + source-file + sweep-ledger signals)
// the processor composes the deterministic edition blocks — "To decide"
// (questions), agenda, integrated-overnight, sources-seen — into TODAY's
// daily, and migrates the retired `dome.agent.brief:*` legacy blocks out in
// the same patch. Byte-identical recomposition emits no patch; a missing
// questions view is LOUD (a warning diagnostic), never a silent empty render.
// Normative: [[wiki/specs/daily-surface]] §"Block ownership" + §"The
// degradation ladder".

import { describe, expect, test } from "bun:test";

import composeBlocks from "../../../assets/extensions/dome.daily/processors/compose-blocks";
import {
  dailyPath,
  dailyPathSettings,
  formatDate,
  localDateParts,
} from "../../../assets/extensions/dome.daily/processors/daily-paths";
import type { DiagnosticEffect, PatchEffect } from "../../../src/core/effect";
import {
  commitOid,
  type CommitOid,
} from "../../../src/core/source-ref";
import {
  treeOid,
  type OperationalQuestionRow,
  type OperationalQueryView,
  type Snapshot,
} from "../../../src/core/processor";
import { makeProcessorContext } from "../../../src/processors/context";

const HEAD_COMMIT = commitOid("8888888888888888888888888888888888888888");
const TREE = treeOid("9999999999999999999999999999999999999999");
const ADOPTED: CommitOid = commitOid(
  "7777777777777777777777777777777777777777",
);

// The compose fires at 05:25 vault-LOCAL; the fixture fire time is built from
// local components so the derived vault date is TZ-robust.
const FIRED_AT = new Date(2026, 5, 5, 5, 25).toISOString();
const SETTINGS = dailyPathSettings(undefined);
const TODAY = localDateParts(new Date(FIRED_AT));
const TODAY_STR = formatDate(TODAY);
const TODAY_PATH = dailyPath(TODAY, SETTINGS);
const CALENDAR_PATH = `sources/calendar/${TODAY_STR}.md`;
const LEDGER_PATH = "meta/sweep-ledger.md";

const QUESTIONS_START = "<!-- dome.daily:questions:start -->";
const AGENDA_START = "<!-- dome.daily:agenda:start -->";
const INTEGRATED_START = "<!-- dome.daily:integrated:start -->";
const SOURCES_START = "<!-- dome.daily:sources:start -->";

// An owner-needed question asked TODAY and an agent-safe question asked
// earlier: the owner-needed row must sort first even though it is younger.
const OWNER_NEEDED: OperationalQuestionRow = questionRow({
  id: 1,
  question: "Ship the pricing change?",
  options: ["yes", "no"],
  askedAt: "2026-06-05T09:00:00.000Z",
  automationPolicy: "owner-needed",
  recommendedAnswer: "yes",
});
const AGENT_SAFE_OLDER: OperationalQuestionRow = questionRow({
  id: 2,
  question: "Rename the widget?",
  askedAt: "2026-06-01T09:00:00.000Z",
  automationPolicy: "agent-safe",
});
const SEEDED: ReadonlyArray<OperationalQuestionRow> = Object.freeze([
  OWNER_NEEDED,
  AGENT_SAFE_OLDER,
]);

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
  "<!-- dome.agent.brief:yesterday:start -->",
  "### Yesterday",
  "- No record of yesterday — no previous daily note.",
  "<!-- dome.agent.brief:yesterday:end -->",
  "",
  "## Meetings",
  "",
  "## Open Loops",
  "",
  "## Notes",
  "",
  "## Done",
  "",
  "## Story of the Day",
  "",
].join("\n");

describe("dome.daily.compose-blocks (D6)", () => {
  test("renders the questions block: owner-needed first, resolve commands present", async () => {
    const { written } = await runCompose(
      { [TODAY_PATH]: BASE_DAILY },
      { operational: viewOf(SEEDED) },
    );
    expect(written).not.toBeNull();
    expect(written!).toContain(QUESTIONS_START);
    expect(written!).toContain("### To decide");
    // Owner-needed sorts before the older agent-safe question.
    const ownerAt = written!.indexOf("Ship the pricing change?");
    const agentAt = written!.indexOf("Rename the widget?");
    expect(ownerAt).toBeGreaterThanOrEqual(0);
    expect(agentAt).toBeGreaterThan(ownerAt);
    // Literal resolve commands render for each question.
    expect(written!).toContain("dome resolve 1 <yes|no>");
    expect(written!).toContain("dome resolve 2 <answer>");
    // The questions block lands after the yesterday block inside ## Start Here.
    const yesterdayAt = written!.indexOf(
      "<!-- dome.agent.brief:yesterday:end -->",
    );
    expect(written!.indexOf(QUESTIONS_START)).toBeGreaterThan(yesterdayAt);
    // Plain bullets only — never checkboxes.
    const body = blockBody(written!, "questions");
    expect(body).not.toContain("- [ ]");
  });

  test("a missing questions view is LOUD (warning diagnostic), block omitted", async () => {
    const { patch, written, diagnostics } = await runCompose(
      { [TODAY_PATH]: BASE_DAILY },
      {}, // no operational view
    );
    const missing = diagnostics.find(
      (d) => d.code === "dome.daily.questions-view-missing",
    );
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("warning");
    // No questions block in whatever was written (if a patch landed at all).
    if (patch !== undefined && written !== null) {
      expect(written).not.toContain(QUESTIONS_START);
    }
  });

  test("agenda: renders from today's calendar file, omitted when absent", async () => {
    const calendar = [
      "- 09:00 — Standup (attendees: Ada, Bo)",
      "- Design review",
    ].join("\n");
    const withCal = await runCompose(
      { [TODAY_PATH]: BASE_DAILY, [CALENDAR_PATH]: calendar },
      { operational: viewOf([]) },
    );
    expect(withCal.written).not.toBeNull();
    expect(withCal.written!).toContain(AGENDA_START);
    expect(withCal.written!).toContain("- 09:00 — Standup (Ada, Bo)");
    expect(withCal.written!).toContain("- Design review");
    // The agenda lands at the top of ## Meetings.
    const meetingsAt = withCal.written!.indexOf("## Meetings");
    expect(withCal.written!.indexOf(AGENDA_START)).toBeGreaterThan(meetingsAt);

    const noCal = await runCompose(
      { [TODAY_PATH]: BASE_DAILY },
      { operational: viewOf([]) },
    );
    expect(noCal.written ?? "").not.toContain(AGENDA_START);
  });

  test("integrated: renders today's sweep-run digest, omitted when absent", async () => {
    const ledger = [
      "# Sweep ledger",
      "cursor:: 2026-06-05",
      `## Run ${TODAY_STR}`,
      "- [[inbox/raw/note-a]] -> [[wiki/projects/alpha]] :: integrated",
      "- [[inbox/raw/note-b]] -> [[wiki/projects/beta]] :: questioned",
      "- [[inbox/raw/note-c]] -> [[wiki/projects/gamma]] :: no-op",
    ].join("\n");
    const withLedger = await runCompose(
      { [TODAY_PATH]: BASE_DAILY, [LEDGER_PATH]: ledger },
      { operational: viewOf([]) },
    );
    expect(withLedger.written).not.toBeNull();
    expect(withLedger.written!).toContain(INTEGRATED_START);
    expect(withLedger.written!).toContain("### Integrated Overnight");
    expect(withLedger.written!).toContain(
      "- [[wiki/projects/alpha]] ← [[inbox/raw/note-a]]",
    );
    expect(withLedger.written!).toContain(
      "- ⚠ pending your answer: [[wiki/projects/beta]] ← [[inbox/raw/note-b]]",
    );
    // no-op rows never surface.
    expect(withLedger.written!).not.toContain("gamma");

    const noLedger = await runCompose(
      { [TODAY_PATH]: BASE_DAILY },
      { operational: viewOf([]) },
    );
    expect(noLedger.written ?? "").not.toContain(INTEGRATED_START);
  });

  test("sources: only records source kinds whose day-file exists today", async () => {
    const withCal = await runCompose(
      { [TODAY_PATH]: BASE_DAILY, [CALENDAR_PATH]: "- Standup" },
      { operational: viewOf([]) },
    );
    expect(withCal.written).not.toBeNull();
    expect(withCal.written!).toContain(SOURCES_START);
    expect(withCal.written!).toContain("_Sources: calendar ✓_");
    expect(withCal.written!).not.toContain("slack");

    const none = await runCompose(
      { [TODAY_PATH]: BASE_DAILY },
      { operational: viewOf([]) },
    );
    expect(none.written ?? "").not.toContain(SOURCES_START);
  });

  test("skeleton creation: no daily present writes the full skeleton + blocks", async () => {
    const { patch, written } = await runCompose(
      { [CALENDAR_PATH]: "- 10:00 — Sync" },
      { operational: viewOf(SEEDED) },
    );
    expect(patch).toBeDefined();
    expect(written).not.toBeNull();
    // Full skeleton scaffolding.
    expect(written!).toContain(`# ${TODAY_STR}`);
    expect(written!).toContain("## Start Here");
    expect(written!).toContain("## Meetings");
    // Composed blocks.
    expect(written!).toContain(QUESTIONS_START);
    expect(written!).toContain(AGENDA_START);
    expect(written!).toContain(SOURCES_START);
  });

  test("legacy migration: old brief blocks removed, new blocks present, today-only", async () => {
    const legacy = [
      "---",
      "type: daily",
      "---",
      "",
      `# ${TODAY_STR}`,
      "",
      "## Start Here",
      "",
      "<!-- dome.agent.brief:questions:start -->",
      "### To decide",
      "- Q9 (owner-needed): stale legacy question",
      "<!-- dome.agent.brief:questions:end -->",
      "",
      "<!-- dome.agent.brief:integrated:start -->",
      "### Integrated Overnight",
      "- [[wiki/x]] ← [[inbox/raw/y]]",
      "<!-- dome.agent.brief:integrated:end -->",
      "",
      "<!-- dome.agent.brief:sources:start -->",
      "_Sources: calendar ✓_",
      "<!-- dome.agent.brief:sources:end -->",
      "",
      "## Meetings",
      "",
    ].join("\n");
    // A historical daily also present in the snapshot must never be touched.
    const historicalPath = "wiki/dailies/2025-01-01.md";
    const { patch, written } = await runCompose(
      { [TODAY_PATH]: legacy, [historicalPath]: legacy },
      { operational: viewOf(SEEDED) },
    );
    expect(written).not.toBeNull();
    // Legacy brief blocks removed.
    expect(written!).not.toContain("<!-- dome.agent.brief:questions:start -->");
    expect(written!).not.toContain(
      "<!-- dome.agent.brief:integrated:start -->",
    );
    expect(written!).not.toContain("<!-- dome.agent.brief:sources:start -->");
    // New dome.daily blocks present.
    expect(written!).toContain(QUESTIONS_START);
    // The patch touches only today's daily — never a historical path.
    expect(patch).toBeDefined();
    expect(patch!.changes.map((c) => String(c.path))).toEqual([TODAY_PATH]);
  });

  test("idempotency: recomposing byte-identical inputs emits no patch", async () => {
    const files = {
      [TODAY_PATH]: BASE_DAILY,
      [CALENDAR_PATH]: "- 09:00 — Standup",
      [LEDGER_PATH]: [
        `## Run ${TODAY_STR}`,
        "- [[inbox/raw/a]] -> [[wiki/b]] :: integrated",
      ].join("\n"),
    };
    const first = await runCompose(files, { operational: viewOf(SEEDED) });
    expect(first.written).not.toBeNull();
    const second = await runCompose(
      { ...files, [TODAY_PATH]: first.written! },
      { operational: viewOf(SEEDED) },
    );
    expect(second.patch).toBeUndefined();
  });

  test("empty-set removal: an existing questions block is dropped when none open", async () => {
    const seeded = await runCompose(
      { [TODAY_PATH]: BASE_DAILY },
      { operational: viewOf(SEEDED) },
    );
    expect(seeded.written).not.toBeNull();
    expect(seeded.written!).toContain(QUESTIONS_START);

    const cleared = await runCompose(
      { [TODAY_PATH]: seeded.written! },
      { operational: viewOf([]) },
    );
    expect(cleared.written).not.toBeNull();
    expect(cleared.written!).not.toContain(QUESTIONS_START);
  });
});

// ----- Harness ---------------------------------------------------------------

function questionRow(input: {
  readonly id: number;
  readonly question: string;
  readonly options?: ReadonlyArray<string>;
  readonly askedAt: string;
  readonly automationPolicy: "agent-safe" | "model-safe" | "owner-needed";
  readonly recommendedAnswer?: string;
}): OperationalQuestionRow {
  return Object.freeze({
    kind: "question",
    question: input.question,
    ...(input.options !== undefined ? { options: Object.freeze(input.options) } : {}),
    sourceRefs: Object.freeze([]),
    idempotencyKey: `test:${input.id}`,
    metadata: Object.freeze({
      automationPolicy: input.automationPolicy,
      ...(input.recommendedAnswer !== undefined
        ? { recommendedAnswer: input.recommendedAnswer }
        : {}),
    }),
    id: input.id,
    processorId: "dome.some.processor",
    runId: "run-x",
    adoptedCommit: ADOPTED,
    askedAt: input.askedAt,
    answeredAt: null,
    answer: null,
  }) as OperationalQuestionRow;
}

function viewOf(
  questions: ReadonlyArray<OperationalQuestionRow>,
): OperationalQueryView {
  return Object.freeze({
    outbox: () => Object.freeze([]),
    quarantines: () => Object.freeze([]),
    orphanRuns: () => Object.freeze([]),
    questions: () => questions,
  });
}

async function runCompose(
  files: Readonly<Record<string, string>>,
  opts: { readonly operational?: OperationalQueryView },
): Promise<{
  readonly patch: PatchEffect | undefined;
  readonly written: string | null;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
}> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(files),
    changedPaths: [],
    proposal: null,
    runId: "run-compose-blocks",
    signal: new AbortController().signal,
    now: new Date(FIRED_AT),
    input: { kind: "schedule", cron: "25 5 * * *", firedAt: FIRED_AT },
    ...(opts.operational !== undefined ? { operational: opts.operational } : {}),
  });
  const effects = await composeBlocks.run(ctx);
  const patch = effects.find(
    (effect): effect is PatchEffect => effect.kind === "patch",
  );
  const diagnostics = effects.filter(
    (effect): effect is DiagnosticEffect => effect.kind === "diagnostic",
  );
  const change = patch?.changes.find((c) => String(c.path) === TODAY_PATH);
  return {
    patch,
    written: change?.kind === "write" ? change.content : null,
    diagnostics,
  };
}

function blockBody(content: string, block: string): string {
  const start = content.indexOf(`<!-- dome.daily:${block}:start -->`);
  const end = content.indexOf(`<!-- dome.daily:${block}:end -->`);
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
            lastChangedAt: "2026-06-05T05:00:00.000Z",
            lastHumanChangedAt: "2026-06-05T05:00:00.000Z",
          },
  });
}
