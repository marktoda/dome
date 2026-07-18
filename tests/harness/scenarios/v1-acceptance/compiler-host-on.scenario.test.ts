// V1 release-hardening proof for host-on steady state: each owner commit is
// followed by one compiler-host tick and the workflow remains immediately
// queryable from adopted state.

import { expect } from "bun:test";

import { TestClock, scenario } from "../../index";
import {
  dailyWithOpenTask,
  expectProcessorRuns,
  HOST_ON_PROCESSOR_RUNS,
  projectPage,
  projectPageTypes,
  SCENARIO_TIMEOUT_MS,
  v1DeterministicConfig,
} from "./compiler-host-modes-fixture";

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
    timeoutMs: SCENARIO_TIMEOUT_MS,
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
    // As in the host-off scenario: only missing-description info nudges from
    // the description-less fixture pages.
    expect(statusPayload.diagnostics).toBe(3);
    await h
      .expectProjection()
      .diagnostics({
        code: "dome.markdown.missing-description",
        severity: "info",
      })
      .toHaveCount(3);
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
    expectProcessorRuns(h, HOST_ON_PROCESSOR_RUNS);
  },
);
