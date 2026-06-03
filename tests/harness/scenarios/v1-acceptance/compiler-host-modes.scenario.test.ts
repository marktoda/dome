// scenarios/v1-acceptance/compiler-host-modes.scenario.test.ts
//
// V1 release-hardening proof for the two local compiler-host modes in the
// product plan:
//   - host-off catch-up: commits accumulate, then `dome sync` catches up;
//   - host-on steady-state: each commit is followed by a compiler tick.

import { expect } from "bun:test";

import { TestClock, scenario } from "../../index";

scenario(
  {
    name: "v1-acceptance: host-off sync catches up accumulated management commits",
    tags: [
      { kind: "group", group: "v1-acceptance" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "trigger", trigger: "command" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "search.write" },
      { kind: "route", route: "adoption" },
      { kind: "route", route: "view-command" },
    ],
    timeoutMs: 30_000,
    harness: {
      clock: new TestClock("2026-01-07T10:00:00.000Z"),
      bundles: [
        "dome.markdown",
        "dome.graph",
        "dome.search",
        "dome.daily",
        "dome.health",
      ],
      initialFiles: {
        ".dome/config.yaml": v1DeterministicConfig(),
        ".dome/page-types.yaml": projectPageTypes(),
        "wiki/dailies/2026-01-06.md": dailyWithOpenTask("2026-01-06"),
      },
    },
  },
  async (h) => {
    const boot = await h.tick();
    expect(boot.adopted).toBe(true);
    await h.expectFile("wiki/dailies/2026-01-07.md").toContain(
      "Review launch staffing plan",
    );

    await h.userCommit({
      message: "capture alpha management followups",
      files: {
        "wiki/projects/alpha.md": projectPage({
          title: "Alpha Launch",
          body: [
            "TODO: Send Ada the launch staffing plan",
            "Follow up: Ask Ben about hiring budget",
            "The staffing risk is blocking the launch readiness review.",
          ],
        }),
      },
    });
    await h.userCommit({
      message: "capture beta management followups",
      files: {
        "wiki/projects/beta.md": projectPage({
          title: "Beta Support",
          body: [
            "TODO: Draft Chris support rotation notes",
            "Follow up: Ask Dana about customer escalation coverage",
            "Customer escalation coverage needs a named owner.",
          ],
        }),
      },
    });

    const pending = await h.runCli(["status", "--json"]);
    expect(pending.exitCode).toBe(0);
    const pendingPayload = JSON.parse(pending.stdout) as {
      readonly pending_commits: number;
    };
    expect(pendingPayload.pending_commits).toBe(2);

    const sync = await h.runCli(["sync", "--json"]);
    expect(sync.exitCode).toBe(0);
    const syncPayload = JSON.parse(sync.stdout) as { readonly status: string };
    expect(syncPayload.status).toBe("adopted");

    const clean = await h.runCli(["status", "--json"]);
    expect(clean.exitCode).toBe(0);
    const cleanPayload = JSON.parse(clean.stdout) as {
      readonly pending_commits: number;
      readonly failed_runs: number;
      readonly diagnostics: number;
    };
    expect(cleanPayload.pending_commits).toBe(0);
    expect(cleanPayload.failed_runs).toBe(0);
    expect(cleanPayload.diagnostics).toBe(0);

    const today = await h.runCli([
      "run",
      "today",
      "--date",
      "2026-01-07",
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
      "Send Ada the launch staffing plan",
    );
    expect(todayPayload.openTasks.map((task) => task.text)).toContain(
      "Draft Chris support rotation notes",
    );
    expect(todayPayload.followups.map((task) => task.text)).toContain(
      "Ask Ben about hiring budget",
    );
    expect(todayPayload.followups.map((task) => task.text)).toContain(
      "Ask Dana about customer escalation coverage",
    );

    const agenda = await h.runCli(["run", "agenda-with", "Ben", "--json"]);
    expect(agenda.exitCode).toBe(0);
    expect(agenda.stdout).toContain("Ask Ben about hiring budget");

    const query = await h.runCli(["query", "customer escalation", "--json"]);
    expect(query.exitCode).toBe(0);
    const queryPayload = JSON.parse(query.stdout) as {
      readonly matches: ReadonlyArray<{ readonly path: string }>;
    };
    expect(queryPayload.matches.map((match) => match.path)).toContain(
      "wiki/projects/beta.md",
    );
  },
);

scenario(
  {
    name: "v1-acceptance: host-on ticks keep management workflow in steady state",
    tags: [
      { kind: "group", group: "v1-acceptance" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "trigger", trigger: "command" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "search.write" },
      { kind: "route", route: "adoption" },
      { kind: "route", route: "garden-schedule" },
      { kind: "route", route: "view-command" },
    ],
    timeoutMs: 30_000,
    harness: {
      clock: new TestClock("2026-01-08T09:00:00.000Z"),
      bundles: [
        "dome.markdown",
        "dome.graph",
        "dome.search",
        "dome.daily",
        "dome.health",
      ],
      initialFiles: {
        ".dome/config.yaml": v1DeterministicConfig(),
        ".dome/page-types.yaml": projectPageTypes(),
        "wiki/dailies/2026-01-07.md": dailyWithOpenTask("2026-01-07"),
      },
    },
  },
  async (h) => {
    const boot = await h.tick();
    expect(boot.adopted).toBe(true);

    await h.userCommit({
      message: "update alpha staffing plan",
      files: {
        "wiki/projects/alpha.md": projectPage({
          title: "Alpha Launch",
          body: [
            "TODO: Send Ada the launch staffing plan",
            "Follow up: Ask Ben about hiring budget",
          ],
        }),
      },
    });
    const alphaTick = await h.tick();
    expect(alphaTick.adopted).toBe(true);

    let status = await h.runCli(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    const alphaStatusPayload = JSON.parse(status.stdout) as {
      readonly pending_commits: number;
    };
    expect(alphaStatusPayload.pending_commits).toBe(0);

    await h.userCommit({
      message: "update daily management notes",
      files: {
        "wiki/dailies/2026-01-08.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-08",
          "---",
          "",
          "# 2026-01-08",
          "",
          "## Notes",
          "",
          "- [ ] Review launch staffing plan",
          "- [ ] #followup Ask Ben about hiring budget",
          "TODO: Prepare Q3 planning packet",
          "",
        ].join("\n"),
      },
    });
    const dailyTick = await h.tick();
    expect(dailyTick.adopted).toBe(true);

    status = await h.runCli(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    const statusPayload = JSON.parse(status.stdout) as {
      readonly pending_commits: number;
      readonly failed_runs: number;
      readonly diagnostics: number;
      readonly questions: number;
    };
    expect(statusPayload.pending_commits).toBe(0);
    expect(statusPayload.failed_runs).toBe(0);
    expect(statusPayload.diagnostics).toBe(0);
    expect(statusPayload.questions).toBe(0);

    const prep = await h.runCli(["run", "prep", "--date", "2026-01-08"]);
    expect(prep.exitCode).toBe(0);
    const prepView = JSON.parse(prep.stdout) as {
      readonly data: { readonly markdown: string };
    };
    expect(prepView.data.markdown).toContain("Prepare Q3 planning packet");
    expect(prepView.data.markdown).toContain("Ask Ben about hiring budget");

    const exportContext = await h.runCli([
      "export-context",
      "launch staffing",
      "--json",
    ]);
    expect(exportContext.exitCode).toBe(0);
    const exportPayload = JSON.parse(exportContext.stdout) as {
      readonly entries: ReadonlyArray<{ readonly path: string }>;
    };
    expect(exportPayload.entries.map((entry) => entry.path)).toContain(
      "wiki/projects/alpha.md",
    );
  },
);

function v1DeterministicConfig(): string {
  return `
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

function dailyWithOpenTask(date: string): string {
  return [
    "---",
    "type: daily",
    `recurrence: ${date}`,
    "---",
    "",
    `# ${date}`,
    "",
    "## Notes",
    "",
    "- [ ] Review launch staffing plan",
    "",
  ].join("\n");
}

function projectPageTypes(): string {
  return [
    "extensions:",
    "  - name: project",
    "    frontmatter_extras:",
    "      title: required",
    "",
  ].join("\n");
}

function projectPage(input: {
  readonly title: string;
  readonly body: ReadonlyArray<string>;
}): string {
  return [
    "---",
    "type: project",
    `title: ${input.title}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    ...input.body,
    "",
  ].join("\n");
}
