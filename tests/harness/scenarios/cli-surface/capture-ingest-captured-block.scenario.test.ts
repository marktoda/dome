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

import {
  CAPTURED_END,
  CAPTURED_START,
  dailyPath,
  dailyPathSettings,
  localDateParts,
} from "../../../../assets/extensions/dome.daily/processors/daily-shared";
import { readBlob } from "../../../../src/git";
import { scenario } from "../../index";

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
      patch.auto:
        - "wiki/**/*.md"
        - "wiki/dailies/*.md"
        - "notes/*.md"
      graph.write:
        - "dome.daily.*"
        - "dome.attention.*"
      question.ask: true
  dome.agent:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
        - "notes/**/*.md"
        - "inbox/**/*.md"
        - "index.md"
        - "log.md"
        - "consolidation-ledger.md"
        - "sources/calendar/*.md"
        - "sweep-ledger.md"
        - "core.md"
        - "preferences/signals.md"
      patch.auto:
        - "wiki/**/*.md"
        - "notes/**/*.md"
        - "index.md"
        - "log.md"
        - "consolidation-ledger.md"
        - "sweep-ledger.md"
        - "inbox/processed/*.md"
        - "inbox/raw/*.md"
        - "preferences/signals.md"
      graph.write:
        - "dome.preference.*"
      model.invoke:
        maxDailyCostUsd: 5
      question.ask: true
`;

scenario(
  {
    name: "cli-surface: dome capture routes a task into the daily's captured block via ingest",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.daily", "dome.agent"],
      initialFiles: { ".dome/config.yaml": CONFIG },
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
      new RegExp(`- \\[ \\] #task ${TASK_BODY} \\^t[0-9a-f]{8}`),
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
  },
);
