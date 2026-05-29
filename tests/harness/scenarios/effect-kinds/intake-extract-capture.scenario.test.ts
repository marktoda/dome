import { createHash } from "node:crypto";

import { expect } from "bun:test";

import { capabilityUsesByRun } from "../../../../src/ledger/capability-uses";
import type { RunId } from "../../../../src/engine/runner-contract";
import { scenario } from "../../index";

const CAPTURE_PATH = "inbox/raw/day.md";
const OUTPUT_PATH = outputPath(CAPTURE_PATH, "wiki/generated/intake");
const ARCHIVE_PATH = outputPath(CAPTURE_PATH, "inbox/processed");
const PROCESSOR_ID = "dome.intake.extract-capture";

const BASE_CONFIG = `
extensions:
  dome.intake:
    enabled: true
    grant:
      read: ["inbox/raw/*.md"]
      patch.auto:
        - "wiki/generated/intake/*.md"
        - "inbox/processed/*.md"
        - "inbox/raw/*.md"
      model.invoke:
        modelAllowlist: ["test-model"]
        maxDailyCostUsd: 1
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
        capability: "patch.auto",
        resource: `${OUTPUT_PATH},${ARCHIVE_PATH},${CAPTURE_PATH}`,
        outcome: "allowed",
      }),
    ]);
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
