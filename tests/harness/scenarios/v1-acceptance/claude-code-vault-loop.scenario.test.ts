// scenarios/v1-acceptance/claude-code-vault-loop.scenario.test.ts
//
// Top-level V1 proof for the local Claude Code vault workflow:
// normal git commits are the write path, one compiler-host tick adopts them,
// first-party garden processors do follow-on work, and CLI views/recovery
// surfaces explain the resulting adopted state.

import { expect } from "bun:test";

import {
  captureOutputPaths,
  captureSourceHash,
} from "../../../../assets/extensions/dome.intake/processors/capture-page";
import { synthesisOutputPath } from "../../../../assets/extensions/dome.intake/processors/synthesize-capture";
import { rollupOutputPath } from "../../../../assets/extensions/dome.intake/processors/synthesize-rollup";
import { TestClock, scenario } from "../../index";

const CAPTURE_PATH = "inbox/raw/manager-day.md";
const CAPTURE_BODY = [
  "# Manager day capture",
  "",
  "Need to send Ada the launch staffing note.",
  "Ask Ben about hiring budget.",
  "",
].join("\n");
const CAPTURE_PATHS = captureOutputPaths({
  path: CAPTURE_PATH,
  sourceHash: captureSourceHash(CAPTURE_BODY),
});
const GENERATED_CAPTURE_PATH = CAPTURE_PATHS.generated;
const ARCHIVE_PATH = CAPTURE_PATHS.archive;
const SYNTHESIS_PATH = synthesisOutputPath(GENERATED_CAPTURE_PATH);
const ROLLUP_PATH = rollupOutputPath();
const COMMAND_PROVIDER_PATH = ".dome/test-command-model-provider.js";
const COMMAND_PROVIDER_SOURCE = `
const request = JSON.parse(await Bun.stdin.text());
if (request.model !== "test-model") {
  console.error("expected test-model");
  process.exit(2);
}
if (
  request.prompt.startsWith(
    "Synthesize recent Dome generated intake captures",
  )
) {
  console.log(JSON.stringify({
    text: JSON.stringify({
      title: "Manager day rollup",
      thesis:
        "Recent captures keep launch staffing and hiring budget follow-up in view.",
      themes: [
        "Ada needs launch staffing notes",
        "Ben owns the hiring budget follow-up",
      ],
      risks: ["Budget follow-up may block the launch staffing thread"],
      nextSteps: ["Send Ada the launch staffing note"],
    }),
    model: request.model,
    costUsd: 0.05,
  }));
} else if (
  request.prompt.startsWith(
    "Synthesize a Dome generated intake capture",
  )
) {
  console.log(JSON.stringify({
    text: JSON.stringify({
      title: "Manager day synthesis",
      thesis:
        "The capture keeps launch staffing and hiring budget follow-up in view.",
      highlights: [
        "Ada needs launch staffing notes",
        "Ben owns the hiring budget follow-up",
      ],
      risks: ["Budget follow-up may block the launch staffing thread"],
      nextSteps: ["Send Ada the launch staffing note"],
    }),
    model: request.model,
    costUsd: 0.05,
  }));
} else {
  console.log(JSON.stringify({
    text: JSON.stringify({
      title: "Manager day follow-up",
      summary:
        "Ada needs launch staffing notes and Ben owns the hiring budget follow-up.",
      tasks: ["Send Ada the launch staffing note"],
      followups: ["Ask Ben about hiring budget"],
      decisions: ["Keep launch staffing review in this week's plan"],
      entities: [],
      sourceQuotes: ["Ask Ben about hiring budget"],
    }),
    model: request.model,
    costUsd: 0.1,
  }));
}
`;

scenario(
  {
    name: "v1-acceptance: Claude Code vault loop adopts, gardens, recalls, and recovers",
    tags: [
      { kind: "group", group: "v1-acceptance" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "trigger", trigger: "command" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "search.write" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "model.invoke" },
    ],
    timeoutMs: 30_000,
    harness: {
      clock: new TestClock("2026-01-06T15:00:00.000Z"),
      bundles: [
        "dome.markdown",
        "dome.graph",
        "dome.search",
        "dome.daily",
        "dome.intake",
        "dome.lint",
        "dome.health",
      ],
      initialFiles: {
        ".dome/config.yaml": v1Config(),
        [COMMAND_PROVIDER_PATH]: COMMAND_PROVIDER_SOURCE,
        "AGENTS.md": [
          "# This is a Dome vault.",
          "",
          "Claude Code edits markdown, commits coherent changes, and uses Dome",
          "commands when it needs adoption status or source-backed views.",
          "",
          "<!-- BEGIN user-prose -->",
          "<!-- END user-prose -->",
          "",
        ].join("\n"),
        "CLAUDE.md": "@AGENTS.md\n",
        "wiki/dailies/2026-01-05.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-05",
          "---",
          "",
          "# 2026-01-05",
          "",
          "## Notes",
          "",
          "- [ ] Review manager packet",
          "- [x] Completed item should not carry forward",
          "",
        ].join("\n"),
      },
    },
  },
  async (h) => {
    const boot = await h.tick();
    expect(boot.adopted).toBe(true);
    await h
      .expectFile("wiki/dailies/2026-01-06.md")
      .toContain("Review manager packet");

    await h.userCommit({
      message: "capture manager day",
      files: {
        "wiki/projects/alpha-review.md": projectPage(),
        "wiki/projects/alpha-review-copy.md": projectPage(),
        [CAPTURE_PATH]: CAPTURE_BODY,
      },
    });

    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    await h.expectFile(GENERATED_CAPTURE_PATH).toContain("# Manager day follow-up");
    await h
      .expectFile(GENERATED_CAPTURE_PATH)
      .toContain("- [ ] Send Ada the launch staffing note");
    await h
      .expectFile(GENERATED_CAPTURE_PATH)
      .toContain("- [ ] #followup Ask Ben about hiring budget");
    await h.expectFile(SYNTHESIS_PATH).toContain("# Manager day synthesis");
    await h.expectFile(SYNTHESIS_PATH).toContain(`[[${GENERATED_CAPTURE_PATH}]]`);
    await h.expectFile(ROLLUP_PATH).toContain("# Manager day rollup");
    await h.expectFile(ROLLUP_PATH).toContain(`[[${GENERATED_CAPTURE_PATH}]]`);
    await h.expectFile(ARCHIVE_PATH).toContain("Need to send Ada");
    const refs = await h.refs.current();
    await h.expectFile(CAPTURE_PATH, { atCommit: refs.head }).toBeAbsent();

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: GENERATED_CAPTURE_PATH,
        objectString: "Send Ada the launch staffing note",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: GENERATED_CAPTURE_PATH,
        objectString: "Ask Ben about hiring budget",
      })
      .toHaveCount(1);

    const status = await h.runCli(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    const statusPayload = JSON.parse(status.stdout) as {
      readonly questions: number;
      readonly failed_runs: number;
      readonly outbox_failed: number;
      readonly quarantined: number;
    };
    expect(statusPayload.questions).toBe(1);
    expect(statusPayload.failed_runs).toBe(0);
    expect(statusPayload.outbox_failed).toBe(0);
    expect(statusPayload.quarantined).toBe(0);

    const today = await h.runCli([
      "run",
      "today",
      "--date",
      "2026-01-06",
      "--json",
    ]);
    expect(today.exitCode).toBe(0);
    const todayView = JSON.parse(today.stdout) as {
      readonly data: {
        readonly openTasks: ReadonlyArray<{ readonly text: string }>;
        readonly followups: ReadonlyArray<{ readonly text: string }>;
      };
    };
    const todayPayload = todayView.data;
    expect(todayPayload.openTasks.map((task) => task.text)).toContain(
      "Send Ada the launch staffing note",
    );
    expect(todayPayload.followups.map((task) => task.text)).toContain(
      "Ask Ben about hiring budget",
    );

    const prep = await h.runCli(["run", "prep", "--date", "2026-01-06"]);
    expect(prep.exitCode).toBe(0);
    const prepView = JSON.parse(prep.stdout) as {
      readonly data: { readonly markdown: string };
    };
    expect(prepView.data.markdown).toContain("# Dome Prep: 2026-01-06");
    expect(prepView.data.markdown).toContain("Ask Ben about hiring budget");

    const query = await h.runCli(["query", "hiring budget", "--json"]);
    expect(query.exitCode).toBe(0);
    const queryPayload = JSON.parse(query.stdout) as {
      readonly matches: ReadonlyArray<{ readonly path: string }>;
    };
    expect(queryPayload.matches.map((match) => match.path)).toContain(
      GENERATED_CAPTURE_PATH,
    );

    const exportContext = await h.runCli([
      "export-context",
      "hiring budget",
      "--json",
    ]);
    expect(exportContext.exitCode).toBe(0);
    const exportPayload = JSON.parse(exportContext.stdout) as {
      readonly markdown: string;
      readonly entries: ReadonlyArray<{
        readonly path: string;
        readonly sourceRefs: ReadonlyArray<{ readonly path: string }>;
      }>;
    };
    expect(exportPayload.markdown).toContain("# Dome Context: hiring budget");
    const exportedCapture = exportPayload.entries.find(
      (entry) => entry.path === GENERATED_CAPTURE_PATH,
    );
    expect(exportedCapture?.sourceRefs[0]?.path).toBe(GENERATED_CAPTURE_PATH);

    const lint = await h.runCli(["lint", "--json"]);
    expect(lint.exitCode).toBe(0);

    const inspectQuestions = await h.runCli(["inspect", "questions", "--json"]);
    expect(inspectQuestions.exitCode).toBe(0);
    const questions = JSON.parse(inspectQuestions.stdout) as ReadonlyArray<{
      readonly id: number;
      readonly status: string;
      readonly question: string;
      readonly options: ReadonlyArray<string> | string;
    }>;
    expect(questions).toHaveLength(1);
    expect(questions[0]?.status).toBe("open");
    expect(questions[0]?.question).toContain("Possible duplicate pages");
    expect(questions[0]?.options).toEqual(["merge", "keep separate"]);

    const questionId = questions[0]?.id;
    expect(questionId).toBeGreaterThan(0);
    if (questionId === undefined) return;
    const answer = await h.runCli([
      "resolve",
      String(questionId),
      "keep separate",
      "--json",
    ]);
    expect(answer.exitCode).toBe(0);
    const answerPayload = JSON.parse(answer.stdout) as {
      readonly status: string;
      readonly question: { readonly status: string; readonly answer: string };
    };
    expect(answerPayload.status).toBe("answered");
    expect(answerPayload.question.status).toBe("answered");
    expect(answerPayload.question.answer).toBe("keep separate");

    const doctor = await h.runCli(["doctor", "--json"]);
    expect(doctor.exitCode).toBe(0);
    const doctorPayload = JSON.parse(doctor.stdout) as {
      readonly summary: { readonly findingCount: number };
    };
    expect(doctorPayload.summary.findingCount).toBe(0);
  },
);

function v1Config(): string {
  return `
model_provider:
  kind: command
  command: ${JSON.stringify([process.execPath, COMMAND_PROVIDER_PATH])}
extensions:
  dome.markdown:
    enabled: true
    grant:
      read:
        - "**/*.md"
        - ".dome/page-types.yaml"
        - "**/*.{png,jpg,jpeg,gif,webp,svg,avif}"
      patch.auto: ["**/*.md"]
      question.ask: true
  dome.graph:
    enabled: true
    grant:
      read: ["**/*.md"]
      graph.write: ["dome.graph.*"]
  dome.search:
    enabled: true
    grant:
      read: ["**/*.md"]
      search.write: ["**/*.md"]
  dome.daily:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
        - "wiki/dailies/*.md"
      patch.auto: ["wiki/**/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
  dome.intake:
    enabled: true
    grant:
      read:
        - "inbox/**/*.md"
        - "wiki/generated/intake/*.md"
        - "wiki/syntheses/intake-*.md"
      patch.auto:
        - "wiki/generated/intake/*.md"
        - "wiki/syntheses/intake-*.md"
        - "inbox/processed/*.md"
        - "inbox/raw/*.md"
      graph.write: ["dome.intake.*"]
      model.invoke:
        modelAllowlist: ["test-model"]
        maxDailyCostUsd: 1
      question.ask: true
  dome.lint:
    enabled: true
    grant:
      read: ["**/*.md"]
  dome.health:
    enabled: true
    grant:
      read: ["**"]
      outbox.read: ["failed"]
      outbox.recover: ["retry", "abandon"]
      quarantine.read: true
      quarantine.recover: ["reset"]
      run.read: ["running"]
      run.recover: ["fail"]
      question.ask: true
`;
}

function projectPage(): string {
  return [
    "---",
    "type: project",
    "title: Alpha Review",
    "tags:",
    "  - management",
    "---",
    "",
    "# Alpha Review",
    "",
    "The alpha management review captures staffing decisions and launch ownership for the manager workflow.",
    "",
    "TODO: Draft launch staffing update",
    "Follow up: Ask Ben about hiring budget",
    "",
  ].join("\n");
}
