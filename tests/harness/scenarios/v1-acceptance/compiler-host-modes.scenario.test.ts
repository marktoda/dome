// scenarios/v1-acceptance/compiler-host-modes.scenario.test.ts
//
// V1 release-hardening proof for host-off catch-up: owner commits accumulate,
// then one explicit `dome sync` catches up the adopted state.

import { expect } from "bun:test";

import { TestClock, scenario } from "../../index";
import {
  dailyWithOpenTask,
  expectProcessorRuns,
  HOST_OFF_PROCESSOR_RUNS,
  projectPage,
  projectPageTypes,
  SCENARIO_TIMEOUT_MS,
  v1DeterministicConfig,
} from "./compiler-host-modes-fixture";

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
    timeoutMs: SCENARIO_TIMEOUT_MS,
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
    // The fixture pages carry no `description:` frontmatter, so every durable
    // diagnostic is the missing-description info nudge — nothing
    // attention-grade.
    expect(cleanPayload.diagnostics).toBe(5);
    await h
      .expectProjection()
      .diagnostics({
        code: "dome.markdown.missing-description",
        severity: "info",
      })
      .toHaveCount(5);

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
    expectProcessorRuns(h, HOST_OFF_PROCESSOR_RUNS);
  },
);
