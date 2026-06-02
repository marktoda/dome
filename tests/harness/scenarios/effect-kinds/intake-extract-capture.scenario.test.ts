import { expect } from "bun:test";

import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import type { RunId } from "../../../../src/engine/runner-contract";
import {
  captureOutputPaths,
  captureSourceHash,
} from "../../../../assets/extensions/dome.intake/processors/capture-page";
import {
  targetFromLowConfidenceQuestionKey,
} from "../../../../assets/extensions/dome.intake/processors/low-confidence-shared";
import {
  captureSynthesisInputHash,
  synthesisOutputPath,
} from "../../../../assets/extensions/dome.intake/processors/synthesize-capture";
import {
  captureRollupInputHash,
  rollupOutputPath,
} from "../../../../assets/extensions/dome.intake/processors/synthesize-rollup";
import { scenario } from "../../index";
import type { Harness } from "../../types";

const CAPTURE_PATH = "inbox/raw/day.md";
const PRIMARY_CAPTURE = [
  "# Capture",
  "",
  "Need to send Ada the launch staffing note.",
  "Ask Ben about hiring budget.",
  "",
].join("\n");
const PRIMARY_PATHS = outputPaths(CAPTURE_PATH, PRIMARY_CAPTURE);
const OUTPUT_PATH = PRIMARY_PATHS.generated;
const ARCHIVE_PATH = PRIMARY_PATHS.archive;
const PRIMARY_SOURCE_HASH = captureSourceHash(PRIMARY_CAPTURE);
const PROCESSOR_ID = "dome.intake.extract-capture";

const BASE_CONFIG = `
extensions:
  dome.intake:
    enabled: true
    grant:
      read:
        - ".dome/config.yaml"
        - ".dome/model-provider.ts"
        - "inbox/**/*.md"
        - "wiki/generated/intake/*.md"
        - "wiki/syntheses/intake-*.md"
      patch.auto:
        - "wiki/generated/intake/*.md"
        - "wiki/syntheses/intake-*.md"
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

const COMMAND_PROVIDER_DISABLED_CONFIG = COMMAND_PROVIDER_CONFIG.replace(
  "  dome.intake:\n    enabled: true",
  "  dome.intake:\n    enabled: false",
);

const COMMAND_PROVIDER_SOURCE = `
const request = JSON.parse(await Bun.stdin.text());
if (request.prompt.startsWith("Synthesize recent Dome generated intake captures")) {
  console.log(JSON.stringify({
    text: JSON.stringify({
      title: "Launch management rollup",
      thesis: "Recent captures point to launch staffing and budget as the active management thread.",
      themes: ["Ada needs launch staffing support", "Ben owns budget follow-up"],
      risks: ["Budget uncertainty may block launch staffing"],
      nextSteps: ["Review launch staffing with Ada and Ben"],
    }),
    model: request.model,
    costUsd: 0.05,
  }));
} else if (
  request.prompt.startsWith("Synthesize a Dome generated intake capture")
) {
  console.log(JSON.stringify({
    text: JSON.stringify({
      title: "Launch staffing synthesis",
      thesis: "The capture identifies launch staffing as the active management thread.",
      highlights: ["Ada needs staffing notes", "Ben owns budget follow-up"],
      risks: ["Budget ownership may block launch staffing"],
      nextSteps: ["Send Ada the staffing note"],
    }),
    model: request.model,
    costUsd: 0.05,
  }));
} else {
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
}
`;

const OLD_CAPTURE_AUTHOR = {
  name: "Dome Test",
  email: "dome-test@example.com",
  timestamp: Date.parse("2025-12-20T00:00:00.000Z") / 1000,
};
const NOOP_CAPTURE_AUTHOR = {
  name: "Dome Test",
  email: "dome-test@example.com",
  timestamp: Date.parse("2026-01-05T12:00:00.000Z") / 1000,
};
const NOOP_GENERATED_PATH = "wiki/generated/intake/noop-day.md";
const NOOP_GENERATED_CONTENT = [
  "---",
  "type: capture",
  "---",
  "",
  "# No-op Day",
  "",
  "Ada needs staffing notes. Ben owns budget follow-up.",
  "",
].join("\n");
const NOOP_LAST_CHANGED_AT = "2026-01-05T12:00:00.000Z";
const NOOP_SYNTHESIS_PATH = synthesisOutputPath(NOOP_GENERATED_PATH);
const NOOP_ROLLUP_PATH = rollupOutputPath();
const NOOP_SYNTHESIS_HASH = captureSynthesisInputHash(
  NOOP_GENERATED_CONTENT,
);
const NOOP_ROLLUP_HASH = captureRollupInputHash([
  {
    path: NOOP_GENERATED_PATH,
    body: NOOP_GENERATED_CONTENT,
    lastChangedAt: NOOP_LAST_CHANGED_AT,
  },
]);
let noopModelCalls = 0;
let extractCalls = 0;

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
        return modelResponseForPrompt(request.prompt, {
          title: "Launch follow-up",
          summary: "Ada needs a staffing note and Ben owns budget follow-up.",
          tasks: ["Send Ada the launch staffing note"],
          followups: ["Ask Ben about hiring budget"],
          decisions: ["Keep launch staffing review in this week's plan"],
          entities: ["Ada", "Ben"],
          sourceQuotes: ["Ask Ben about hiring budget"],
        });
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        [CAPTURE_PATH]: PRIMARY_CAPTURE,
      },
      message: "capture day",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h.expectFile(OUTPUT_PATH).toContain("# Launch follow-up");
    await h.expectFile(OUTPUT_PATH).toContain("- [ ] Send Ada the launch staffing note");
    await h.expectFile(OUTPUT_PATH).toContain("- [ ] #followup Ask Ben about hiring budget");
    await h.expectFile(OUTPUT_PATH).toContain(`[[${ARCHIVE_PATH}]]`);
    await h.expectFile(OUTPUT_PATH).toContain(`source_hash: ${PRIMARY_SOURCE_HASH}`);
    await h.expectFile(OUTPUT_PATH).toContain("disposition: digested");
    await h.expectFile(ARCHIVE_PATH).toContain("Need to send Ada");
    await h.expectFile(ARCHIVE_PATH).toContain(`source_hash: ${PRIMARY_SOURCE_HASH}`);
    await h.expectFile(ARCHIVE_PATH).toContain("disposition: archived");
    await h
      .expectFile(synthesisOutputPath(OUTPUT_PATH))
      .toContain("# Launch staffing synthesis");
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
        objectString: "Ask Ben about hiring budget",
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

    const [run] = successfulExtractCaptureModelRuns(h);
    expect(successfulExtractCaptureModelRuns(h)).toHaveLength(1);
    if (run === undefined) throw new Error("expected one model-backed extract run");
    expect(run?.cost_usd).toBe(0.1);
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
    name: "convergence: dome.intake digests pending raw captures when enabled later",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "group", group: "convergence" },
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
        ".dome/config.yaml": COMMAND_PROVIDER_DISABLED_CONFIG,
        [COMMAND_PROVIDER_PATH]: COMMAND_PROVIDER_SOURCE,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        [CAPTURE_PATH]: PRIMARY_CAPTURE,
      },
      message: "capture while intake disabled",
    });
    const disabledTick = await h.tick();
    expect(disabledTick.adopted).toBe(true);
    await h.expectFile(CAPTURE_PATH).toContain("Need to send Ada");
    await h
      .expectLedger({ processorId: PROCESSOR_ID })
      .toHaveCount(0);

    await h.userCommit({
      files: {
        ".dome/config.yaml": COMMAND_PROVIDER_CONFIG,
      },
      message: "enable intake",
    });
    const sync = await h.runCli(["sync", "--json"]);
    expect(sync.exitCode).toBe(0);
    expect(sync.stderr).toBe("");

    await h.expectFile(OUTPUT_PATH).toContain("# Command launch follow-up");
    await h.expectFile(ARCHIVE_PATH).toContain("Need to send Ada");
    await h.expectFile(CAPTURE_PATH).toBeAbsent();
    await h
      .expectProjection()
      .facts({
        predicate: "dome.intake.task",
        subjectId: OUTPUT_PATH,
        objectString: "Send Ada the launch staffing note",
      })
      .toHaveCount(1);
    expect(successfulExtractCaptureModelRuns(h)).toHaveLength(1);

    const settled = await h.runCli(["sync", "--json"]);
    expect(settled.exitCode).toBe(0);
    expect(successfulExtractCaptureModelRuns(h)).toHaveLength(1);
  },
);

scenario(
  {
    name: "effect-kinds: dome.intake preserves repeated captures with same raw path",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "capability", capability: "model.invoke" },
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
        return modelResponseForPrompt(request.prompt, {
          title: request.prompt.includes("second staffing note")
            ? "Second launch follow-up"
            : "First launch follow-up",
          summary: "A launch staffing follow-up was captured.",
          tasks: ["Send Ada the launch staffing note"],
          followups: [],
          decisions: [],
          entities: ["Ada"],
          sourceQuotes: ["launch staffing"],
        });
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const firstCapture = "# Capture\n\nNeed the first staffing note.\n";
    const secondCapture = "# Capture\n\nNeed the second staffing note.\n";
    const firstPaths = outputPaths(CAPTURE_PATH, firstCapture);
    const secondPaths = outputPaths(CAPTURE_PATH, secondCapture);
    expect(firstPaths.generated).not.toBe(secondPaths.generated);
    expect(firstPaths.archive).not.toBe(secondPaths.archive);

    await h.userCommit({
      files: { [CAPTURE_PATH]: firstCapture },
      message: "capture first day",
    });
    const first = await h.tick();
    expect(first.adopted).toBe(true);

    await h.userCommit({
      files: { [CAPTURE_PATH]: secondCapture },
      message: "capture second day",
    });
    const second = await h.tick();
    expect(second.adopted).toBe(true);

    await h.expectFile(firstPaths.generated).toContain("# First launch follow-up");
    await h.expectFile(secondPaths.generated).toContain("# Second launch follow-up");
    await h.expectFile(firstPaths.archive).toContain("first staffing note");
    await h.expectFile(secondPaths.archive).toContain("second staffing note");
    expect(successfulExtractCaptureModelRuns(h)).toHaveLength(2);
  },
);

scenario(
  {
    name: "convergence: dome.intake clears already-digested raw captures without model churn",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "group", group: "convergence" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "question" },
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
        if (request.prompt.startsWith("Extract a Dome capture")) {
          extractCalls += 1;
          return modelResponseForPrompt(request.prompt, {
            title: "Launch uncertainty",
            summary: "Chris may need a staffing check.",
            tasks: [
              { text: "Ask Chris about launch staffing", confidence: 0.45 },
            ],
            followups: [],
            decisions: [],
            entities: [],
            sourceQuotes: [],
          });
        }
        return modelResponseForPrompt(request.prompt, {
          title: "Launch staffing synthesis",
          summary: "A launch staffing follow-up was captured.",
          tasks: [],
          followups: [],
          decisions: [],
          entities: [],
          sourceQuotes: [],
        });
      },
    },
  },
  async (h) => {
    extractCalls = 0;
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const capture = [
      "# Capture",
      "",
      "Maybe Chris needs a launch staffing check.",
      "",
    ].join("\n");
    const paths = outputPaths(CAPTURE_PATH, capture);

    await h.userCommit({
      files: { [CAPTURE_PATH]: capture },
      message: "capture uncertain day",
    });
    const first = await h.tick();
    expect(first.adopted).toBe(true);
    expect(extractCalls).toBe(1);
    await h.expectProjection().questions().toHaveCount(1);

    await h.userCommit({
      files: { [CAPTURE_PATH]: capture },
      message: "reintroduce same raw capture",
    });
    const second = await h.tick();
    expect(second.adopted).toBe(true);
    expect(extractCalls).toBe(1);
    await h.expectFile(CAPTURE_PATH).toBeAbsent();
    await h.expectFile(paths.generated).toContain("intake_pending_items:");
    await h.expectFile(paths.archive).toContain("Maybe Chris needs");
    await h.expectProjection().questions().toHaveCount(1);
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("Ask Chris about launch staffing");
  },
);

scenario(
  {
    name: "effect-kinds: dome.intake synthesizes generated capture pages",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
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
        return modelResponseForPrompt(request.prompt, {
          title: "Unused extraction",
          summary: "Unused",
          tasks: [],
          followups: [],
          decisions: [],
          entities: [],
          sourceQuotes: [],
        });
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const generatedPath = "wiki/generated/intake/manager-day.md";
    const generatedContent = [
      "---",
      "type: capture",
      "---",
      "",
      "# Manager Day",
      "",
      "Ada needs staffing notes. Ben owns budget follow-up.",
      "",
    ].join("\n");
    await h.userCommit({
      files: {
        [generatedPath]: generatedContent,
      },
      message: "add generated capture",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    const synthesisPath = synthesisOutputPath(generatedPath);
    await h.expectFile(synthesisPath).toContain("# Launch staffing synthesis");
    await h
      .expectFile(synthesisPath)
      .toContain("[[wiki/generated/intake/manager-day.md]]");
    await h
      .expectFile(synthesisPath)
      .toContain(`input_hash: ${captureSynthesisInputHash(generatedContent)}`);
    await h
      .expectFile(synthesisPath)
      .toContain("- Ben owns budget follow-up");

    const run = await h
      .expectLedger({
        processorId: "dome.intake.synthesize-capture",
        status: "succeeded",
      })
      .toHaveExactlyOne();
    expect(capabilityUsesByRun(h.ledger, run.id as RunId)).toEqual([
      expect.objectContaining({
        capability: "model.invoke",
        resource: "test-model",
        outcome: "allowed",
      }),
      expect.objectContaining({
        capability: "patch.auto",
        resource: synthesisPath,
        outcome: "allowed",
      }),
    ]);
  },
);

scenario(
  {
    name: "effect-kinds: dome.intake skips current capture syntheses without model churn",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "group", group: "convergence" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "garden-signal" },
    ],
    harness: {
      bundles: ["dome.intake", "dome.daily", "dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": BASE_CONFIG,
        [NOOP_SYNTHESIS_PATH]: [
          "---",
          "type: synthesis",
          `sources: ["[[${NOOP_GENERATED_PATH}]]"]`,
          `generated_from: ${JSON.stringify(NOOP_GENERATED_PATH)}`,
          `input_hash: ${NOOP_SYNTHESIS_HASH}`,
          "processor: dome.intake.synthesize-capture",
          "---",
          "",
          "# Existing Capture Synthesis",
          "",
          "Already synthesized.",
          "",
        ].join("\n"),
        [NOOP_ROLLUP_PATH]: [
          "---",
          "type: synthesis",
          "sources:",
          `  - "[[${NOOP_GENERATED_PATH}]]"`,
          `input_hash: ${NOOP_ROLLUP_HASH}`,
          "processor: dome.intake.synthesize-rollup",
          "---",
          "",
          "# Existing Rollup",
          "",
          "Already rolled up.",
          "",
        ].join("\n"),
      },
      modelProvider: async () => {
        noopModelCalls += 1;
        throw new Error("model should not be invoked for current syntheses");
      },
    },
  },
  async (h) => {
    noopModelCalls = 0;
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        [NOOP_GENERATED_PATH]: NOOP_GENERATED_CONTENT,
      },
      message: "add already-synthesized generated capture",
      author: NOOP_CAPTURE_AUTHOR,
      committer: NOOP_CAPTURE_AUTHOR,
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);
    expect(noopModelCalls).toBe(0);
    await h.expectFile(NOOP_SYNTHESIS_PATH).toContain(
      "# Existing Capture Synthesis",
    );
    await h.expectFile(NOOP_ROLLUP_PATH).toContain("# Existing Rollup");
    await h
      .expectLedger({
        processorId: "dome.intake.synthesize-capture",
        status: "succeeded",
        withOutputCommit: false,
      })
      .toHaveExactlyOne();
    await h
      .expectLedger({
        processorId: "dome.intake.synthesize-rollup",
        status: "succeeded",
        withOutputCommit: false,
      })
      .toHaveExactlyOne();
  },
);

scenario(
  {
    name: "effect-kinds: dome.intake synthesizes cross-capture rollups",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
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
        if (
          request.prompt.startsWith(
            "Synthesize recent Dome generated intake captures",
          )
        ) {
          expect(request.prompt).toContain(
            "wiki/generated/intake/manager-day.md",
          );
          expect(request.prompt).toContain(
            "wiki/generated/intake/project-day.md",
          );
          return {
            text: JSON.stringify({
              title: "Launch management rollup",
              thesis:
                "Recent captures point to launch staffing and budget as the active management thread.",
              themes: [
                "Ada needs launch staffing support",
                "Ben owns budget follow-up",
              ],
              risks: ["Budget uncertainty may block launch staffing"],
              nextSteps: ["Review launch staffing with Ada and Ben"],
            }),
            costUsd: 0.07,
          };
        }
        return modelResponseForPrompt(request.prompt, {
          title: "Unused per-capture synthesis",
          summary: "Unused",
          tasks: [],
          followups: [],
          decisions: [],
          entities: [],
          sourceQuotes: [],
        });
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/generated/intake/manager-day.md": [
          "---",
          "type: capture",
          "---",
          "",
          "# Manager Day",
          "",
          "Ada needs launch staffing support.",
          "",
        ].join("\n"),
        "wiki/generated/intake/project-day.md": [
          "---",
          "type: capture",
          "---",
          "",
          "# Project Day",
          "",
          "Ben owns budget follow-up for the launch.",
          "",
        ].join("\n"),
      },
      message: "add generated captures",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    const rollupPath = rollupOutputPath();
    await h.expectFile(rollupPath).toContain("# Launch management rollup");
    await h
      .expectFile(rollupPath)
      .toContain("Recent captures point to launch staffing");
    await h.expectFile(rollupPath).toMatch(/^input_hash: [a-f0-9]{64}$/m);
    await h
      .expectFile(rollupPath)
      .toContain("- Ada needs launch staffing support");
    await h
      .expectFile(rollupPath)
      .toContain("- [[wiki/generated/intake/manager-day.md]]");
    await h
      .expectFile(rollupPath)
      .toContain("- [[wiki/generated/intake/project-day.md]]");

    const run = await h
      .expectLedger({
        processorId: "dome.intake.synthesize-rollup",
        status: "succeeded",
      })
      .toHaveExactlyOne();
    expect(capabilityUsesByRun(h.ledger, run.id as RunId)).toEqual([
      expect.objectContaining({
        capability: "model.invoke",
        resource: "test-model",
        outcome: "allowed",
      }),
      expect.objectContaining({
        capability: "patch.auto",
        resource: rollupPath,
        outcome: "allowed",
      }),
    ]);

    await h.userCommit({
      files: {
        "wiki/generated/intake/manager-day.md": null,
        "wiki/generated/intake/project-day.md": null,
      },
      message: "delete generated captures",
    });
    const deleted = await h.tick();
    expect(deleted.adopted).toBe(true);
    await h.expectFile(rollupPath).toBeAbsent();

    await h
      .expectLedger({ processorId: "dome.intake.synthesize-rollup" })
      .toAllHaveStatus("succeeded");
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
        [CAPTURE_PATH]: PRIMARY_CAPTURE,
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

    const [run] = successfulExtractCaptureModelRuns(h);
    expect(successfulExtractCaptureModelRuns(h)).toHaveLength(1);
    if (run === undefined) throw new Error("expected one model-backed extract run");
    expect(run?.cost_usd).toBe(0.2);
  },
);

scenario(
  {
    name: "convergence: dome.intake digests raw captures already present at first adoption",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "group", group: "convergence" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "fact" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "route", route: "garden-schedule" },
    ],
    harness: {
      bundles: ["dome.intake", "dome.daily", "dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": BASE_CONFIG,
        [CAPTURE_PATH]: PRIMARY_CAPTURE,
      },
      modelProvider: async (request) => {
        expect(request.model).toBe("test-model");
        return modelResponseForPrompt(request.prompt, {
          title: "First adoption capture",
          summary:
            "Ada needs a launch staffing note and Ben owns the budget follow-up.",
          tasks: ["Send Ada the launch staffing note"],
          followups: ["Ask Ben about hiring budget"],
          decisions: ["Keep launch staffing review in this week's plan"],
          entities: ["Ada", "Ben"],
          sourceQuotes: ["Ask Ben about hiring budget"],
        });
      },
    },
  },
  async (h) => {
    const first = await h.tick();
    expect(first.adopted).toBe(true);

    await h.expectFile(OUTPUT_PATH).toContain("# First adoption capture");
    await h.expectFile(ARCHIVE_PATH).toContain("Need to send Ada");
    await h.expectFile(CAPTURE_PATH).toBeAbsent();
    await h
      .expectProjection()
      .facts({
        predicate: "dome.intake.task",
        subjectId: OUTPUT_PATH,
        objectString: "Send Ada the launch staffing note",
      })
      .toHaveCount(1);
    expect(successfulExtractCaptureModelRuns(h)).toHaveLength(1);

    const settled = await h.runCli(["sync", "--json"]);
    expect(settled.exitCode).toBe(0);
    expect(successfulExtractCaptureModelRuns(h)).toHaveLength(1);
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
      modelProvider: async (request) =>
        modelResponseForPrompt(request.prompt, {
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
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const capture = [
      "# Capture",
      "",
      "Need to send Ada the launch staffing note.",
      "Ask Ben about hiring budget.",
      "Maybe Chris or Dana need something for Phoenix?",
      "",
    ].join("\n");
    const paths = outputPaths(CAPTURE_PATH, capture);

    await h.userCommit({
      files: {
        [CAPTURE_PATH]: capture,
      },
      message: "capture uncertain day",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h.expectFile(paths.generated).toContain("- [ ] Send Ada the launch staffing note");
    await h.expectFile(paths.generated).toContain("- [ ] #followup Ask Ben about hiring budget");
    await h.expectFile(paths.generated).toNotContain("- [ ] Ask Chris about launch staffing");
    await h
      .expectFile(paths.generated)
      .toNotContain("- [ ] #followup Check whether Dana needs");
    await h.expectFile(paths.generated).toContain("intake_pending_items:");
    await h.expectFile(paths.generated).toContain("Ask Chris about launch staffing");
    await h
      .expectProjection()
      .facts({
        predicate: "dome.intake.task",
        subjectId: paths.generated,
        objectString: "Send Ada the launch staffing note",
      })
      .toHaveCount(1);
    expect(
      factConfidence(
        h,
        "dome.intake.task",
        "Send Ada the launch staffing note",
        paths.generated,
      ),
    ).toBe(0.95);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.intake.task",
        subjectId: paths.generated,
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
      sourceHash: captureSourceHash(capture),
      generatedPath: paths.generated,
      kind: "task",
      text: "Ask Chris about launch staffing",
      confidence: 0.45,
    });
    expect(targets).not.toContain(null);

    const sourceRefRows = h.projection.raw
      .query<{ source_refs: string }, []>(
        "SELECT source_refs FROM questions ORDER BY id",
      )
      .all();
    expect(
      sourceRefRows.every((row) =>
        JSON.parse(row.source_refs).some(
          (ref: { readonly path: string }) => ref.path === paths.generated,
        )
      ),
    ).toBe(true);

    const rebuild = await h.runCli(["rebuild", "--json"]);
    expect(rebuild.exitCode).toBe(0);
    await h.expectProjection().questions().toHaveCount(4);
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("Ask Chris about launch staffing");
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
      modelProvider: async (request) =>
        modelResponseForPrompt(request.prompt, {
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
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const capture = [
      "# Capture",
      "",
      "Maybe Chris needs a launch staffing check.",
      "",
    ].join("\n");
    const paths = outputPaths(CAPTURE_PATH, capture);

    await h.userCommit({
      files: {
        [CAPTURE_PATH]: capture,
      },
      message: "capture uncertain task",
    });

    const extracted = await h.tick();
    expect(extracted.adopted).toBe(true);
    await h.expectFile(paths.generated).toNotContain(
      "- [ ] Ask Chris about launch staffing",
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
      "resolve",
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

    await h.expectFile(paths.generated).toContain(
      "- [ ] Ask Chris about launch staffing",
    );
    await h
      .expectProjection()
      .facts({
        predicate: "dome.intake.task",
        subjectId: paths.generated,
        objectString: "Ask Chris about launch staffing",
      })
      .toHaveCount(1);
    expect(
      factConfidence(
        h,
        "dome.intake.task",
        "Ask Chris about launch staffing",
        paths.generated,
      ),
    ).toBe(0.45);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: paths.generated,
        objectString: "Ask Chris about launch staffing",
      })
      .toHaveCount(1);
  },
);

scenario(
  {
    name: "effect-kinds: dome.intake warns on stale inbox files",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "capability", capability: "read" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "trigger", trigger: "signal" },
      { kind: "route", route: "garden-schedule" },
      { kind: "route", route: "garden-signal" },
    ],
    harness: {
      bundles: ["dome.intake"],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.intake:
    enabled: true
    grant:
      read: ["inbox/**/*.md"]
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "inbox/clip/old.md": "# Old clip\n\nStill here.\n",
        "inbox/review/old.md": "# Review output\n",
        "inbox/processed/old.md": "# Processed capture\n",
      },
      message: "old inbox files",
      author: OLD_CAPTURE_AUTHOR,
      committer: OLD_CAPTURE_AUTHOR,
    });

    const stale = await h.tick();
    expect(stale.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "inbox.stale", severity: "warning" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "inbox.stale", severity: "warning" })
      .toContainMessage("inbox/clip/old.md");

    await h.userCommit({
      files: {
        "inbox/clip/old.md": null,
      },
      message: "delete stale clip",
    });

    const resolved = await h.tick();
    expect(resolved.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "inbox.stale", severity: "warning" })
      .toHaveCount(0);
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
      bundles: ["dome.intake", "dome.daily", "dome.markdown"],
      initialFiles: {
        ".dome/config.yaml": BASE_CONFIG,
      },
      modelProvider: async () => ({ text: "{\"title\":\"missing arrays\"}" }),
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const capture = "# Capture\n\nIncomplete output test.\n";
    const paths = outputPaths(CAPTURE_PATH, capture);

    await h.userCommit({
      files: { [CAPTURE_PATH]: capture },
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
    await h.expectFile(paths.generated).toBeAbsent();
    await h.expectFile(paths.archive).toBeAbsent();
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
      read:
        - "inbox/**/*.md"
        - "wiki/generated/intake/*.md"
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

    const capture = "# Capture\n\nTry to write outside grant.\n";
    const paths = outputPaths(CAPTURE_PATH, capture);

    await h.userCommit({
      files: { [CAPTURE_PATH]: capture },
      message: "capture denied write",
    });
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "capability-deny-patch", severity: "error" })
      .toHaveCount(1);
    await h.expectFile(CAPTURE_PATH).toContain("Try to write outside grant.");
    await h.expectFile(paths.generated).toBeAbsent();
    await h.expectFile(paths.archive).toBeAbsent();
  },
);

function outputPaths(path: string, content: string): {
  readonly generated: string;
  readonly archive: string;
} {
  return captureOutputPaths({ path, sourceHash: captureSourceHash(content) });
}

type CaptureExtractionFixture = {
  readonly title: string;
  readonly summary: string;
  readonly tasks: ReadonlyArray<unknown>;
  readonly followups: ReadonlyArray<unknown>;
  readonly decisions: ReadonlyArray<unknown>;
  readonly entities: ReadonlyArray<unknown>;
  readonly sourceQuotes: ReadonlyArray<unknown>;
};

function modelResponseForPrompt(
  prompt: string,
  extraction: CaptureExtractionFixture,
): { readonly text: string; readonly costUsd: number } {
  if (prompt.startsWith("Synthesize recent Dome generated intake captures")) {
    return {
      text: JSON.stringify({
        title: "Launch management rollup",
        thesis:
          "Recent captures point to launch staffing and budget as the active management thread.",
        themes: [
          "Ada needs launch staffing support",
          "Ben owns budget follow-up",
        ],
        risks: ["Budget uncertainty may block launch staffing"],
        nextSteps: ["Review launch staffing with Ada and Ben"],
      }),
      costUsd: 0.05,
    };
  }
  if (prompt.startsWith("Synthesize a Dome generated intake capture")) {
    return {
      text: JSON.stringify({
        title: "Launch staffing synthesis",
        thesis:
          "The capture identifies launch staffing as the active management thread.",
        highlights: [
          "Ada needs staffing notes",
          "Ben owns budget follow-up",
        ],
        risks: ["Budget ownership may block launch staffing"],
        nextSteps: ["Send Ada the staffing note"],
      }),
      costUsd: 0.05,
    };
  }
  return {
    text: JSON.stringify(extraction),
    costUsd: 0.1,
  };
}

function successfulExtractCaptureModelRuns(
  h: Harness,
): ReadonlyArray<{ readonly id: string; readonly cost_usd: number | null }> {
  return h.ledger.raw
    .query<
      { id: string; cost_usd: number | null },
      [string]
    >(
      "SELECT id, cost_usd FROM runs WHERE processor_id = ? AND status = 'succeeded' ORDER BY started_at",
    )
    .all(PROCESSOR_ID)
    .filter((run) =>
      capabilityUsesByRun(h.ledger, run.id as RunId).some(
        (use) =>
          use.capability === "model.invoke" && use.outcome === "allowed",
      ),
    );
}

function factConfidence(
  h: Harness,
  predicate: string,
  objectString: string,
  subjectId = OUTPUT_PATH,
): number | null {
  const rows = h.projection.raw
    .query<{ object_json: string; confidence: number | null }, [string, string]>(
      "SELECT object_json, confidence FROM facts WHERE predicate = ? AND subject_id = ?",
    )
    .all(predicate, subjectId);
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
