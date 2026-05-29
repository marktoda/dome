import { createHash } from "node:crypto";

import { expect } from "bun:test";

import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import type { RunId } from "../../../../src/engine/runner-contract";
import {
  targetFromLowConfidenceQuestionKey,
} from "../../../../assets/extensions/dome.intake/processors/low-confidence-shared";
import { scenario } from "../../index";
import type { Harness } from "../../types";

const CAPTURE_PATH = "inbox/raw/day.md";
const OUTPUT_PATH = outputPath(CAPTURE_PATH, "wiki/generated/intake");
const ARCHIVE_PATH = outputPath(CAPTURE_PATH, "inbox/processed");
const PROCESSOR_ID = "dome.intake.extract-capture";

const BASE_CONFIG = `
extensions:
  dome.intake:
    enabled: true
    grant:
      read:
        - "inbox/raw/*.md"
        - "wiki/generated/intake/*.md"
      patch.auto:
        - "wiki/generated/intake/*.md"
        - "inbox/processed/*.md"
        - "inbox/raw/*.md"
      graph.write:
        - "dome.intake.*"
      model.invoke:
        modelAllowlist: ["test-model"]
        maxDailyCostUsd: 1
      question.ask: true
  dome.daily:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
  dome.markdown:
    enabled: true
    grant:
      read:
        - "**/*.md"
        - ".dome/page-types.yaml"
      patch.auto: ["**/*.md"]
      question.ask: true
`;

const COMMAND_PROVIDER_PATH = ".dome/test-command-model-provider.js";

const COMMAND_PROVIDER_CONFIG = `
model_provider:
  kind: command
  command: ${JSON.stringify([process.execPath, COMMAND_PROVIDER_PATH])}
${BASE_CONFIG}
`;

const COMMAND_PROVIDER_SOURCE = `
const request = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify({
  text: JSON.stringify({
    title: "Command launch follow-up",
    summary: "Ada needs a staffing note and Ben owns budget follow-up.",
    tasks: ["Send Ada the launch staffing note"],
    followups: ["Ask Ben about hiring budget"],
    decisions: ["Keep launch staffing review in this week's plan"],
    entities: ["Ada", "Ben"],
    sourceQuotes: ["Ask Ben about hiring budget"],
  }),
  model: request.model,
  costUsd: 0.2,
}));
`;

scenario(
  {
    name: "effect-kinds: dome.intake extracts raw capture into generated markdown and task facts",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "fact" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "garden-signal" },
    ],
    harness: {
      bundles: ["dome.intake", "dome.daily", "dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": BASE_CONFIG,
      },
      modelProvider: async (request) => {
        expect(request.model).toBe("test-model");
        return {
          text: JSON.stringify({
            title: "Launch follow-up",
            summary: "Ada needs a staffing note and Ben owns budget follow-up.",
            tasks: ["Send Ada the launch staffing note"],
            followups: ["Ask Ben about hiring budget"],
            decisions: ["Keep launch staffing review in this week's plan"],
            entities: ["Ada", "Ben"],
            sourceQuotes: ["Ask Ben about hiring budget"],
          }),
          costUsd: 0.1,
        };
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        [CAPTURE_PATH]: [
          "# Capture",
          "",
          "Need to send Ada the launch staffing note.",
          "Ask Ben about hiring budget.",
          "",
        ].join("\n"),
      },
      message: "capture day",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h.expectFile(OUTPUT_PATH).toContain("# Launch follow-up");
    await h.expectFile(OUTPUT_PATH).toContain("- [ ] Send Ada the launch staffing note");
    await h.expectFile(OUTPUT_PATH).toContain("- [ ] #followup Ask Ben about hiring budget");
    await h.expectFile(OUTPUT_PATH).toContain(`[[${ARCHIVE_PATH}]]`);
    await h.expectFile(ARCHIVE_PATH).toContain("Need to send Ada");
    const refs = await h.refs.current();
    if (refs.head === null) throw new Error("expected HEAD");
    await h.expectFile(CAPTURE_PATH, { atCommit: refs.head }).toBeAbsent();

    await h
      .expectProjection()
      .facts({
        predicate: "dome.intake.task",
        subjectId: OUTPUT_PATH,
        objectString: "Send Ada the launch staffing note",
      })
      .toHaveCount(1);
    expect(
      factConfidence(h, "dome.intake.task", "Send Ada the launch staffing note"),
    ).toBe(1);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: OUTPUT_PATH,
        objectString: "Send Ada the launch staffing note",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: OUTPUT_PATH,
        objectString: "#followup Ask Ben about hiring budget",
      })
      .toHaveCount(1);

    const rebuild = await h.runCli(["rebuild", "--json"]);
    expect(rebuild.exitCode).toBe(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.intake.task",
        subjectId: OUTPUT_PATH,
        objectString: "Send Ada the launch staffing note",
      })
      .toHaveCount(1);
    expect(
      factConfidence(h, "dome.intake.task", "Send Ada the launch staffing note"),
    ).toBe(1);

    const run = await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "succeeded" })
      .toHaveExactlyOne();
    const cost = h.ledger.raw
      .query<{ cost_usd: number | null }, [string]>(
        "SELECT cost_usd FROM runs WHERE id = ?",
      )
      .get(run.id);
    expect(cost?.cost_usd).toBe(0.1);
    expect(capabilityUsesByRun(h.ledger, run.id as RunId)).toEqual([
      expect.objectContaining({
        capability: "model.invoke",
        resource: "test-model",
        outcome: "allowed",
      }),
      expect.objectContaining({
        capability: "patch.auto",
        resource: `${OUTPUT_PATH},${ARCHIVE_PATH},${CAPTURE_PATH}`,
        outcome: "allowed",
      }),
    ]);
  },
);

scenario(
  {
    name: "effect-kinds: dome.intake uses configured command model provider through CLI sync",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "fact" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "garden-signal" },
    ],
    harness: {
      bundles: ["dome.intake", "dome.daily", "dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": COMMAND_PROVIDER_CONFIG,
        [COMMAND_PROVIDER_PATH]: COMMAND_PROVIDER_SOURCE,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        [CAPTURE_PATH]: [
          "# Capture",
          "",
          "Need to send Ada the launch staffing note.",
          "Ask Ben about hiring budget.",
          "",
        ].join("\n"),
      },
      message: "capture day",
    });

    const cli = await h.runCli(["sync", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");

    await h.expectFile(OUTPUT_PATH).toContain("# Command launch follow-up");
    await h
      .expectFile(OUTPUT_PATH)
      .toContain("- [ ] Send Ada the launch staffing note");
    await h.expectFile(ARCHIVE_PATH).toContain("Need to send Ada");
    const refs = await h.refs.current();
    if (refs.head === null) throw new Error("expected HEAD");
    await h.expectFile(CAPTURE_PATH, { atCommit: refs.head }).toBeAbsent();

    const run = await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "succeeded" })
      .toHaveExactlyOne();
    const cost = h.ledger.raw
      .query<{ cost_usd: number | null }, [string]>(
        "SELECT cost_usd FROM runs WHERE id = ?",
      )
      .get(run.id);
    expect(cost?.cost_usd).toBe(0.2);
  },
);

scenario(
  {
    name: "effect-kinds: dome.intake asks before tracking low-confidence capture items",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "question" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "capability", capability: "question.ask" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "garden-signal" },
    ],
    harness: {
      bundles: ["dome.intake", "dome.daily", "dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": BASE_CONFIG,
      },
      modelProvider: async () => ({
        text: JSON.stringify({
          title: "Launch follow-up",
          summary: "Ada needs a staffing note; Chris may need a check-in.",
          tasks: [
            { text: "Send Ada the launch staffing note", confidence: 0.95 },
            { text: "Ask Chris about launch staffing", confidence: 0.45 },
          ],
          followups: [
            { text: "Ask Ben about hiring budget", confidence: 0.92 },
            { text: "Check whether Dana needs a status note", confidence: 0.5 },
          ],
          decisions: [
            { text: "Keep launch staffing review this week", confidence: 0.93 },
            { text: "Move all reviews to Friday", confidence: 0.4 },
          ],
          entities: [
            { text: "Ada", confidence: 0.99 },
            { text: "Project Phoenix", confidence: 0.35 },
          ],
          sourceQuotes: ["Ask Ben about hiring budget"],
        }),
      }),
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        [CAPTURE_PATH]: [
          "# Capture",
          "",
          "Need to send Ada the launch staffing note.",
          "Ask Ben about hiring budget.",
          "Maybe Chris or Dana need something for Phoenix?",
          "",
        ].join("\n"),
      },
      message: "capture uncertain day",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h.expectFile(OUTPUT_PATH).toContain("- [ ] Send Ada the launch staffing note");
    await h.expectFile(OUTPUT_PATH).toContain("- [ ] #followup Ask Ben about hiring budget");
    await h.expectFile(OUTPUT_PATH).toNotContain("Ask Chris about launch staffing");
    await h.expectFile(OUTPUT_PATH).toNotContain("Check whether Dana needs");
    await h
      .expectProjection()
      .facts({
        predicate: "dome.intake.task",
        subjectId: OUTPUT_PATH,
        objectString: "Send Ada the launch staffing note",
      })
      .toHaveCount(1);
    expect(
      factConfidence(h, "dome.intake.task", "Send Ada the launch staffing note"),
    ).toBe(0.95);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.intake.task",
        subjectId: OUTPUT_PATH,
        objectString: "Ask Chris about launch staffing",
      })
      .toHaveCount(0);
    await h.expectProjection().questions().toHaveCount(4);
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("Low-confidence task");
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("Ask Chris about launch staffing");
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("Project Phoenix");

    const questionRows = h.projection.raw
      .query<{ idempotency_key: string }, []>(
        "SELECT idempotency_key FROM questions ORDER BY id",
      )
      .all();
    const targets = questionRows.map((row) =>
      targetFromLowConfidenceQuestionKey(row.idempotency_key),
    );
    expect(targets).toContainEqual({
      version: 1,
      path: CAPTURE_PATH,
      kind: "task",
      text: "Ask Chris about launch staffing",
      confidence: 0.45,
    });
    expect(targets).not.toContain(null);
  },
);

scenario(
  {
    name: "effect-routing: dome.intake tracks accepted low-confidence answers",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "question" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "fact" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "capability", capability: "question.ask" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "answer" },
      { kind: "route", route: "garden-answer" },
    ],
    harness: {
      bundles: ["dome.intake", "dome.daily", "dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": BASE_CONFIG,
      },
      modelProvider: async () => ({
        text: JSON.stringify({
          title: "Launch follow-up",
          summary: "Chris may need a staffing check.",
          tasks: [
            { text: "Ask Chris about launch staffing", confidence: 0.45 },
          ],
          followups: [],
          decisions: [],
          entities: [],
          sourceQuotes: [],
        }),
      }),
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        [CAPTURE_PATH]: [
          "# Capture",
          "",
          "Maybe Chris needs a launch staffing check.",
          "",
        ].join("\n"),
      },
      message: "capture uncertain task",
    });

    const extracted = await h.tick();
    expect(extracted.adopted).toBe(true);
    await h.expectFile(OUTPUT_PATH).toNotContain(
      "Ask Chris about launch staffing",
    );

    const inspect = await h.runCli(["inspect", "questions", "--json"]);
    expect(inspect.exitCode).toBe(0);
    const rows = JSON.parse(inspect.stdout) as ReadonlyArray<{
      readonly id: number;
      readonly status: string;
      readonly options: ReadonlyArray<string>;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("open");
    expect(rows[0]?.options).toEqual(["track", "ignore"]);

    const questionId = rows[0]?.id;
    expect(questionId).toBeGreaterThan(0);
    if (questionId === undefined) return;

    const answer = await h.runCli([
      "answer",
      String(questionId),
      "track",
      "--json",
    ]);
    expect(answer.exitCode).toBe(0);
    expect(answer.stderr).toBe("");
    const answered = JSON.parse(answer.stdout) as {
      readonly status: string;
      readonly handlers: {
        readonly status: string;
        readonly runs: ReadonlyArray<{ readonly processor_id: string }>;
        readonly sub_proposals: number;
      };
    };
    expect(answered.status).toBe("answered");
    expect(answered.handlers.status).toBe("handled");
    expect(answered.handlers.runs.map((run) => run.processor_id)).toEqual([
      "dome.intake.low-confidence-answer",
    ]);
    expect(answered.handlers.sub_proposals).toBe(1);

    await h.expectFile(OUTPUT_PATH).toContain(
      "- [ ] Ask Chris about launch staffing",
    );
    await h
      .expectProjection()
      .facts({
        predicate: "dome.intake.task",
        subjectId: OUTPUT_PATH,
        objectString: "Ask Chris about launch staffing",
      })
      .toHaveCount(1);
    expect(
      factConfidence(h, "dome.intake.task", "Ask Chris about launch staffing"),
    ).toBe(0.45);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: OUTPUT_PATH,
        objectString: "Ask Chris about launch staffing",
      })
      .toHaveCount(1);
  },
);

scenario(
  {
    name: "effect-kinds: dome.intake model-output failure leaves raw capture intact",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.intake"],
      initialFiles: {
        ".dome/config.yaml": BASE_CONFIG,
      },
      modelProvider: async () => ({ text: "{\"title\":\"missing arrays\"}" }),
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: { [CAPTURE_PATH]: "# Capture\n\nIncomplete output test.\n" },
      message: "capture with bad model output",
    });
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    const failed = await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "failed" })
      .toHaveExactlyOne();
    expect(JSON.parse(failed.error ?? "{}").code).toBe(
      "model.output.schema-mismatch",
    );
    await h
      .expectProjection()
      .diagnostics({ code: "model.output.schema-mismatch", severity: "error" })
      .toHaveCount(1);
    await h.expectFile(CAPTURE_PATH).toContain("Incomplete output test.");
    await h.expectFile(OUTPUT_PATH).toBeAbsent();
    await h.expectFile(ARCHIVE_PATH).toBeAbsent();
  },
);

scenario(
  {
    name: "effect-kinds: dome.intake cannot mutate outside granted capture paths",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.intake"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.intake:
    enabled: true
    grant:
      read: ["inbox/raw/*.md"]
      patch.auto:
        - "inbox/processed/*.md"
        - "inbox/raw/*.md"
      model.invoke:
        modelAllowlist: ["test-model"]
`,
      },
      modelProvider: async () => ({
        text: JSON.stringify({
          title: "Denied write",
          summary: "The generated wiki path is not granted.",
          tasks: ["Try to write outside grant"],
          followups: [],
          decisions: [],
          entities: [],
          sourceQuotes: ["Try to write outside grant"],
        }),
      }),
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: { [CAPTURE_PATH]: "# Capture\n\nTry to write outside grant.\n" },
      message: "capture denied write",
    });
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "capability-deny-patch", severity: "error" })
      .toHaveCount(1);
    await h.expectFile(CAPTURE_PATH).toContain("Try to write outside grant.");
    await h.expectFile(OUTPUT_PATH).toBeAbsent();
    await h.expectFile(ARCHIVE_PATH).toBeAbsent();
  },
);

function outputPath(path: string, dir: string): string {
  const basename = path.split("/").at(-1) ?? "capture.md";
  const stem = basename.replace(/\.md$/i, "");
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "capture";
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
  return `${dir}/${slug}-${digest}.md`;
}

function factConfidence(
  h: Harness,
  predicate: string,
  objectString: string,
): number | null {
  const rows = h.projection.raw
    .query<{ object_json: string; confidence: number | null }, [string, string]>(
      "SELECT object_json, confidence FROM facts WHERE predicate = ? AND subject_id = ?",
    )
    .all(predicate, OUTPUT_PATH);
  for (const row of rows) {
    const object = JSON.parse(row.object_json) as {
      readonly kind?: unknown;
      readonly value?: unknown;
    };
    if (object.kind === "string" && object.value === objectString) {
      return row.confidence;
    }
  }
  return null;
}
