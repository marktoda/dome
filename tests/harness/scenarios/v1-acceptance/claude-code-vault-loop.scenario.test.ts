// scenarios/v1-acceptance/claude-code-vault-loop.scenario.test.ts
//
// Top-level V1 proof for the local Claude Code vault workflow:
// normal git commits are the write path, one compiler-host tick adopts them,
// first-party garden processors do follow-on work, and CLI views/recovery
// surfaces explain the resulting adopted state.

import { expect } from "bun:test";

import { TestClock, scenario } from "../../index";

const PROJECT_PATH = "wiki/projects/alpha-review.md";

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
    ],
    timeoutMs: 30_000,
    harness: {
      clock: new TestClock("2026-01-06T15:00:00.000Z"),
      bundles: [
        "dome.markdown",
        "dome.graph",
        "dome.search",
        "dome.daily",
        "dome.lint",
        "dome.health",
      ],
      initialFiles: {
        ".dome/config.yaml": v1Config(),
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
        [PROJECT_PATH]: projectPage(),
        // An ambiguous wikilink raises dome.markdown.ambiguous-wikilink's
        // question — the raise+resolve beat this acceptance loop exercises
        // (duplicate-detection retired; dedup is dome.agent.consolidate's job).
        "wiki/page.md":
          "# Page\n\nWorking with [[wiki/entities/grae-danco#Notes|Grace]].\n",
        "wiki/entities/grace-danco.md": "# Grace Danco\n",
        "wiki/entities/grade-danco.md": "# Grade Danco\n",
      },
    });

    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: PROJECT_PATH,
        objectString: "Draft launch staffing update",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: PROJECT_PATH,
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
      "Draft launch staffing update",
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
      PROJECT_PATH,
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
    const exportedProject = exportPayload.entries.find(
      (entry) => entry.path === PROJECT_PATH,
    );
    expect(exportedProject?.sourceRefs[0]?.path).toBe(PROJECT_PATH);

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
    expect(questions[0]?.question).toContain(
      "[[wiki/entities/grae-danco#Notes]]",
    );
    expect(questions[0]?.options).toEqual([
      "wiki/entities/grace-danco#Notes",
      "wiki/entities/grade-danco#Notes",
      "keep unresolved",
    ]);

    const questionId = questions[0]?.id;
    expect(questionId).toBeGreaterThan(0);
    if (questionId === undefined) return;
    const answer = await h.runCli([
      "resolve",
      String(questionId),
      "keep unresolved",
      "--json",
    ]);
    expect(answer.exitCode).toBe(0);
    const answerPayload = JSON.parse(answer.stdout) as {
      readonly status: string;
      readonly question: { readonly status: string; readonly answer: string };
    };
    expect(answerPayload.status).toBe("answered");
    expect(answerPayload.question.status).toBe("answered");
    expect(answerPayload.question.answer).toBe("keep unresolved");

    const doctor = await h.runCli(["doctor", "--json"]);
    expect(doctor.exitCode).toBe(0);
    const doctorPayload = JSON.parse(doctor.stdout) as {
      readonly summary: { readonly findingCount: number };
    };
    expect(doctorPayload.summary.findingCount).toBe(0);
  },
);

// Mirrors the shipped first-party defaults (src/cli/default-vault-config.ts)
// closely enough that doctor's grant probes stay quiet: every manifest-declared
// read/patch.auto pattern of the enabled bundles is granted (raw/** for
// dome.markdown.raw-immutable; notes/*.md, the alternate daily_path shape, for
// dome.daily) — the scenario pins findingCount 0.
function v1Config(): string {
  return `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read:
        - "**/*.md"
        - ".dome/page-types.yaml"
        - "**/*.{png,jpg,jpeg,gif,webp,svg,avif}"
        - "raw/**"
      patch.auto: ["**/*.md"]
      graph.write: ["dome.page.*"]
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
        - "notes/*.md"
      patch.auto: ["wiki/**/*.md", "notes/*.md"]
      graph.write: ["dome.daily.*", "dome.attention.*"]
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
