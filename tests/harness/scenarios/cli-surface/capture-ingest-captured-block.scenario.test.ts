// scenarios/cli-surface/capture-ingest-captured-block.scenario.test.ts
//
// Daily-surface D3 end-to-end (docs/wiki/specs/daily-surface.md §"The
// section contract" / §"The ingest tool seam" + docs/wiki/specs/capture.md
// §"The landing zone"): `dome capture "<idea>"` → the raw capture is
// adopted → the ingest agent (scripted fake model, real tool seam) routes
// the tactical task into today's daily INSIDE the `dome.daily:captured`
// block → the garden cascade stamps its `^anchor` and task-index projects
// the open_task fact — the captured line is an ORIGIN, fully inside the
// task pipeline. The model script only names lines; placement is the
// seam's, so the landing position is asserted structurally.

import { expect } from "bun:test";
import { join } from "node:path";

import { dailyPath, dailyPathSettings, localDateParts } from "../../../../assets/extensions/dome.daily/processors/daily-paths";
import { CAPTURED_END, CAPTURED_START } from "../../../../assets/extensions/dome.daily/processors/daily-types";
import { readBlob } from "../../../../src/git";
import { scenario, TestClock } from "../../index";

const STEP_PROVIDER = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "model-providers",
  "captured-ingest-step.ts",
);

const TASK_BODY = "call the landlord about the radiator";

// Bundle grants mirror the shipped manifests; the command model provider is
// the scripted step script above (fresh process per step — state lives in
// the message history).
const CONFIG = `
model_provider:
  kind: command
  command: ["bun", ${JSON.stringify(STEP_PROVIDER)}]
extensions:
  dome.daily:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
        - "notes/*.md"
        - "sources/calendar/*.md"
        - "sources/slack/*.md"
      patch.auto:
        - "wiki/**/*.md"
        - "wiki/dailies/*.md"
        - "notes/*.md"
      graph.write:
        - "dome.daily.*"
      question.ask: true
      questions.read: true
      proposals.read: true
  dome.agent:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
        - "notes/**/*.md"
        - "inbox/**/*.md"
        - "index.md"
        - "log.md"
        - "sources/calendar/*.md"
        - "sources/slack/*.md"
        - "core.md"
        - "preferences/signals.md"
      patch.auto:
        - "wiki/**/*.md"
        - "notes/**/*.md"
        - "index.md"
        - "log.md"
        - "inbox/processed/*.md"
        - "inbox/raw/*.md"
        - "preferences/signals.md"
      graph.write:
        - "dome.preference.*"
      model.invoke:
        maxDailyCostUsd: 5
      question.ask: true
      patch.propose:
        - "wiki/**/*.md"
      proposals.read: true
    processors:
      dome.agent.preference-promotion-answer:
        grant:
          read: ["core.md", "preferences/signals.md"]
          patch.auto: ["core.md", "preferences/signals.md"]
      dome.agent.active-projects:
        grant:
          read: ["core.md", "wiki/dailies/*.md"]
          patch.auto: ["core.md"]
  dome.markdown:
    enabled: true
    grant:
      read:
        - "**/*.md"
        - ".dome/page-types.yaml"
        - "**/*.{png,jpg,jpeg,gif,webp,svg,avif}"
        - "raw/**"
      patch.auto:
        - "**/*.md"
      patch.propose:
        - "notes/**"
        - "wiki/**"
        - "attic/**"
      graph.write:
        - "dome.page.*"
      question.ask: true
  dome.search:
    enabled: true
    grant:
      read:
        - "**/*.md"
      search.write:
        - "**/*.md"
`;

scenario(
  {
    name: "cli-surface: first-user journey captures, recalls, decides, and gardens",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      clock: new TestClock("2026-07-11T12:00:00.000Z"),
      bundles: ["dome.daily", "dome.agent", "dome.markdown", "dome.search"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
        "AGENTS.md": [
          "# This is a Dome vault.",
          "",
          "<!-- BEGIN user-prose -->",
          "<!-- END user-prose -->",
          "",
        ].join("\n"),
        "CLAUDE.md": "@AGENTS.md\n",
      },
    },
  },
  async (h) => {
    // Baseline tick: adopt the config; first-tick schedules fire, so
    // create-daily lays down today's skeleton (captured block included).
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const todayPath = dailyPath(
      localDateParts(h.clock.now()),
      dailyPathSettings(undefined),
    );
    await h.expectFile(todayPath).toContain("## Captured today");
    await h.expectFile(todayPath).toContain(CAPTURED_START);

    // Capture from the CLI — an ordinary human commit, no engine contact.
    const capture = await h.runCli(["capture", TASK_BODY, "--json"]);
    expect(capture.exitCode).toBe(0);
    const payload = JSON.parse(capture.stdout) as { readonly path: string };
    expect(payload.path).toMatch(/^inbox\/raw\//);

    // Add a small knowledge page for recall/gardening plus one bounded owner
    // decision. This lands after the first schedule tick, so semantic garden
    // execution does not invoke the ingest-specific scripted provider; its
    // deterministic view can still compile the orphan opportunity.
    await h.userCommit({
      message: "add first-user knowledge and one decision",
      files: {
        "wiki/concepts/home-heating.md": [
          "---",
          "type: concept",
          "description: Radiator maintenance and landlord follow-up",
          "status: active",
          "---",
          "# Home heating",
          "",
          "The radiator needs landlord follow-up before winter.",
          "",
        ].join("\n"),
        "wiki/decision.md": "# Decision\n\nAsk [[wiki/entities/grae-danco|Grace]].\n",
        "wiki/entities/grace-danco.md": "# Grace Danco\n",
        "wiki/entities/grade-danco.md": "# Grade Danco\n",
      },
    });

    // One tick adopts the capture; ingest fires on the inbox signal, the
    // scripted model appends the task line + archives the source, and the
    // garden cascade (stamp-block-id) anchors the new line. A second tick
    // drains any remaining cascade work idempotently.
    const tick = await h.tick();
    expect(tick.adopted).toBe(true);
    await h.tick();

    const adopted = await h.refs.adopted();
    if (adopted === null) throw new Error("adopted ref missing after tick");

    // The task line landed INSIDE the captured block (seam-positioned),
    // carries #task, and was anchored by the next hygiene cycle.
    const daily = await readBlob({
      path: h.vaultPath,
      commit: String(adopted),
      filepath: todayPath,
    });
    if (daily === null) throw new Error(`missing ${todayPath} at adopted`);
    const start = daily.indexOf(CAPTURED_START);
    const end = daily.indexOf(CAPTURED_END);
    const task = daily.indexOf(`- [ ] #task ${TASK_BODY}`);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(task).toBeGreaterThan(start);
    expect(task).toBeLessThan(end);
    expect(daily).toMatch(
      new RegExp(`- \\[ \\] #task ${TASK_BODY} \\(\\[↗\\]\\(inbox/processed/[^)]+\\.md\\)\\) \\^t[0-9a-f]{8}`),
    );

    // The raw capture was consumed (inbox is ephemeral) …
    await h.expectFile(payload.path, { atCommit: adopted }).toBeAbsent();
    await h
      .expectFile(payload.path.replace("inbox/raw/", "inbox/processed/"), {
        atCommit: adopted,
      })
      .toExist();

    // … and the captured line is an ORIGIN in the projection: task-index
    // emitted its open_task fact.
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        objectString: TASK_BODY,
      })
      .toHaveCount(1);

    const today = await h.runCli(["today", "--json"]);
    expect(today.exitCode).toBe(0);
    const todayPayload = JSON.parse(today.stdout) as {
      readonly openTasks: ReadonlyArray<{ readonly text: string }>;
    };
    expect(todayPayload.openTasks.map((item) => item.text)).toContain(TASK_BODY);

    const query = await h.runCli([
      "query",
      "what needs landlord follow-up for winter",
      "--json",
    ]);
    expect(query.exitCode).toBe(0);
    const queryPayload = JSON.parse(query.stdout) as {
      readonly matches: ReadonlyArray<{ readonly path: string }>;
    };
    expect(queryPayload.matches.map((match) => match.path)).toContain(
      "wiki/concepts/home-heating.md",
    );

    const garden = await h.runCli(["garden", "--json"]);
    expect(garden.exitCode).toBe(0);
    const gardenPayload = JSON.parse(garden.stdout) as {
      readonly data: {
        readonly opportunities: ReadonlyArray<{
          readonly kind: string;
          readonly paths: ReadonlyArray<string>;
        }>;
      };
    };
    expect(gardenPayload.data.opportunities).toContainEqual(
      expect.objectContaining({
        kind: "orphan-page",
        paths: ["wiki/concepts/home-heating.md"],
      }),
    );

    const questions = await h.runCli(["inspect", "questions", "--json"]);
    expect(questions.exitCode).toBe(0);
    const questionRows = JSON.parse(questions.stdout) as ReadonlyArray<{
      readonly id: number;
      readonly status: string;
    }>;
    const open = questionRows.find((question) => question.status === "open");
    expect(open?.id).toBeGreaterThan(0);
    if (open !== undefined) {
      const resolve = await h.runCli([
        "resolve",
        String(open.id),
        "keep unresolved",
        "--json",
      ]);
      expect(resolve.exitCode).toBe(0);
    }

    const doctor = await h.runCli(["doctor", "--json"]);
    expect(doctor.exitCode).toBe(0);
    const doctorPayload = JSON.parse(doctor.stdout) as {
      readonly status: string;
      readonly summary: { readonly errorCount: number; readonly warningCount: number };
    };
    expect(doctorPayload.status).toBe("ok");
    expect(doctorPayload.summary.errorCount).toBe(0);
    expect(doctorPayload.summary.warningCount).toBe(0);
  },
);
