// scenarios/effect-routing/questions-changed-compose.scenario.test.ts
//
// The compiled-daily product loop end-to-end through the REAL dome.daily
// bundle (daily-surface §"Block ownership" + processors.md §"Triggers and
// signals"). Unlike triggers/questions-changed-dispatch (which proves the
// once-per-tick dispatch mechanics against a FIXTURE subscriber), this
// scenario drives the shipped `dome.daily.compose-blocks` compositor:
//
//   (a) A fixture processor asks one durable question. Its `recordQuestion`
//       sink sets the host tick's questions-changed flag; the tick epilogue
//       dispatches compose-blocks (a `questions.changed` subscriber), which
//       composes today's daily. After the tick, the adopted daily contains
//       the `dome.daily:questions` block — the `### To decide` heading and a
//       `dome resolve` line for the open question.
//   (b) Resolving that question through the host resolve path (`dome resolve`
//       → vault.resolve → runAnswerHandlersForQuestion, which dispatches
//       questions.changed subscribers after the durable answer lands)
//       recomposes the daily with no open questions, so the block is removed
//       entirely — the adopted daily no longer lists it.
//   (c) The compose commit is engine-authored (the four Dome-* trailers).
//
// Every assertion is against the adopted file content at the engine-advanced
// head — never a processor return value — and every mutation crosses the
// engine boundary (host tick epilogue / host resolve seam), never the
// processor's run() directly.
//
// On the signal/epilogue path, compose-blocks derives its target date from
// `ctx.now()` (a `questions.changed` fire carries no firedAt) — the real
// clock, exactly as it does in production. The expected daily path is derived
// with the processor's own daily-paths helpers so the assertion tracks that
// real "today" instead of a hardcoded date.

import { expect } from "bun:test";
import { join } from "node:path";

import {
  dailyPath,
  dailyPathSettings,
  localDateParts,
} from "../../../../assets/extensions/dome.daily/processors/daily-paths";
import { TestClock, scenario } from "../../index";

const COMPOSE_QUESTION_BUNDLE_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.compose-question",
);

// The instant this scenario runs. Both the TestClock (schedule-fired composes)
// and the real-clock ctx.now() (signal-fired composes) resolve to this local
// date, so create-daily and compose-blocks agree on a single daily.
const NOW = new Date();
const TODAY_PATH = dailyPath(localDateParts(NOW), dailyPathSettings(undefined));
const QUESTIONS_START = "<!-- dome.daily:questions:start -->";
const QUESTION_TEXT = "test.compose-question: ship the pricing change?";

scenario(
  {
    name: "effect-routing: questions.changed compiles the To-decide block; resolve clears it",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "questions.read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "answer" },
    ],
    harness: {
      clock: new TestClock(NOW.toISOString()),
      bundles: [
        "dome.daily",
        { id: "test.compose-question", root: COMPOSE_QUESTION_BUNDLE_ROOT },
      ],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.daily:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
        - "notes/*.md"
        - "sources/calendar/*.md"
        - "sources/slack/*.md"
        - "meta/sweep-ledger.md"
      patch.auto: ["wiki/dailies/*.md", "notes/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
      questions.read: true
  test.compose-question:
    enabled: true
    grant:
      read: ["queue/ask.md"]
      question.ask: true
`,
      },
    },
  },
  async (h) => {
    // Seed the adopted ref. No question exists yet — nothing to list.
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    // (a) The fixture asks its question. The recordQuestion sink sets the
    // host's questions-changed flag; the tick epilogue dispatches the real
    // compose-blocks compositor, which composes today's daily.
    await h.userCommit({
      files: { "queue/ask.md": "# Ask\n\nplaceholder\n" },
      message: "trigger the fixture ask",
    });
    const asked = await h.tick();
    expect(asked.adopted).toBe(true);

    // Exactly one open question — the fixture's — and compose-blocks ran.
    const rows = JSON.parse(
      (await h.runCli(["inspect", "questions", "--json"])).stdout,
    ) as ReadonlyArray<{ readonly id: number; readonly status: string }>;
    expect(rows.length).toBe(1);
    const questionId = rows[0]?.id;
    expect(questionId).toBeGreaterThan(0);
    if (questionId === undefined) return;
    expect(rows[0]?.status).toBe("open");

    await h
      .expectLedger({ processorId: "dome.daily.compose-blocks" })
      .toHaveAtLeastOne();

    // The adopted daily now carries the "To decide" block listing the open
    // question with its resolve command.
    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    await h.expectFile(TODAY_PATH, { atCommit: adopted }).toContain(QUESTIONS_START);
    await h.expectFile(TODAY_PATH, { atCommit: adopted }).toContain("### To decide");
    await h.expectFile(TODAY_PATH, { atCommit: adopted }).toContain(QUESTION_TEXT);
    await h
      .expectFile(TODAY_PATH, { atCommit: adopted })
      .toContain(`dome resolve ${questionId} <yes|no>`);

    // (c) The compose commit is engine-authored — the canonical four Dome-*
    // trailers a user commit never carries.
    const composeCommits = await h.git.commitsMatching(
      /dome\.daily\.compose-blocks/,
    );
    expect(composeCommits.length).toBeGreaterThan(0);
    const composeCommit = composeCommits[0];
    if (composeCommit === undefined) return;
    await h
      .expectCommit(composeCommit.oid)
      .toHaveAllTrailers([
        "Dome-Run",
        "Dome-Extension",
        "Dome-Base",
        "Dome-Source-Head",
      ]);

    // (b) Resolve through the host resolve path. vault.resolve records the
    // durable answer and dispatches questions.changed subscribers, so
    // compose-blocks recomposes with no open questions.
    const resolved = await h.runCli([
      "resolve",
      String(questionId),
      "yes",
      "--json",
    ]);
    expect(resolved.exitCode).toBe(0);
    expect(resolved.stderr).toBe("");
    const answered = JSON.parse(resolved.stdout) as {
      readonly status: string;
      readonly question: { readonly status: string; readonly answer: string };
    };
    expect(answered.status).toBe("answered");
    expect(answered.question.status).toBe("answered");
    expect(answered.question.answer).toBe("yes");

    // The block is dropped entirely — the adopted daily no longer lists it.
    const afterResolve = await h.refs.adopted();
    expect(afterResolve).not.toBeNull();
    if (afterResolve === null) return;
    await h
      .expectFile(TODAY_PATH, { atCommit: afterResolve })
      .toNotContain(QUESTIONS_START);
    await h
      .expectFile(TODAY_PATH, { atCommit: afterResolve })
      .toNotContain(QUESTION_TEXT);
  },
);
