// dome.intake.extract-capture — compile raw inbox captures into markdown.

import { createHash } from "node:crypto";

import { patchEffect, type Effect } from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { z } from "zod";

type CaptureExtraction = {
  readonly title: string;
  readonly summary: string;
  readonly tasks: ReadonlyArray<string>;
  readonly followups: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly entities: ReadonlyArray<string>;
  readonly sourceQuotes: ReadonlyArray<string>;
};

const MODEL_SCHEMA = "dome.intake.extract-capture/v1";
const NonEmptyTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "expected non-empty string");
const CaptureExtractionSchema = z
  .object({
    title: NonEmptyTrimmedString,
    summary: NonEmptyTrimmedString,
    tasks: z.array(NonEmptyTrimmedString),
    followups: z.array(NonEmptyTrimmedString),
    decisions: z.array(NonEmptyTrimmedString),
    entities: z.array(NonEmptyTrimmedString),
    sourceQuotes: z.array(NonEmptyTrimmedString),
  })
  .strict();

const extractCapture: Processor = defineProcessor({
  id: "dome.intake.extract-capture",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: "inbox/raw/*.md" },
  ],
  capabilities: [
    { kind: "read", paths: ["inbox/raw/*.md"] },
    {
      kind: "patch.auto",
      paths: [
        "wiki/generated/intake/*.md",
        "inbox/processed/*.md",
        "inbox/raw/*.md",
      ],
    },
    { kind: "model.invoke", maxDailyCostUsd: 5 },
  ],
  execution: {
    class: "llm",
    timeoutMs: 600_000,
    modelCallTimeoutMs: 180_000,
  },
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.modelInvoke === undefined) {
      throw new Error("dome.intake.extract-capture requires model.invoke");
    }

    const effects: Effect[] = [];
    for (const path of ctx.changedPaths.filter(isRawCapturePath).sort()) {
      const capture = await ctx.snapshot.readFile(path);
      if (capture === null) continue;

      const extraction = await ctx.modelInvoke.structured({
        schemaName: MODEL_SCHEMA,
        prompt: promptForCapture(path, capture),
        parse: parseCaptureExtraction,
      });
      const paths = outputPaths(path);
      const archive = renderArchive({ sourcePath: path, capture });
      const generated = renderGeneratedCapture({
        sourcePath: path,
        archivePath: paths.archive,
        extraction,
      });

      effects.push(
        patchEffect({
          mode: "auto",
          changes: [
            {
              kind: "write",
              path: paths.generated,
              content: generated,
            },
            {
              kind: "write",
              path: paths.archive,
              content: archive,
            },
            {
              kind: "delete",
              path,
            },
          ],
          reason: `dome.intake: extract capture ${path}`,
          sourceRefs: [ctx.sourceRef(path)],
        }),
      );
    }
    return Object.freeze(effects);
  },
});

export default extractCapture;

function isRawCapturePath(path: string): boolean {
  return /^inbox\/raw\/[^/]+\.md$/.test(path);
}

function promptForCapture(path: string, capture: string): string {
  return [
    "Extract a Dome capture into strict JSON.",
    "Return only JSON with keys:",
    "title:string, summary:string, tasks:string[], followups:string[], decisions:string[], entities:string[], sourceQuotes:string[].",
    "Tasks should be concrete open action items.",
    "Followups should be people/project follow-up actions.",
    "Decisions should be explicit decisions from the capture.",
    "Source quotes should be short exact excerpts from the capture.",
    "",
    `Capture path: ${path}`,
    "",
    capture,
  ].join("\n");
}

function parseCaptureExtraction(value: unknown): CaptureExtraction {
  const parsed = CaptureExtractionSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return deepFreezeExtraction({
    title: parsed.data.title,
    summary: parsed.data.summary,
    tasks: parsed.data.tasks,
    followups: parsed.data.followups,
    decisions: parsed.data.decisions,
    entities: parsed.data.entities,
    sourceQuotes: parsed.data.sourceQuotes,
  });
}

function deepFreezeExtraction(input: {
  readonly title: string;
  readonly summary: string;
  readonly tasks: ReadonlyArray<string>;
  readonly followups: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly entities: ReadonlyArray<string>;
  readonly sourceQuotes: ReadonlyArray<string>;
}): CaptureExtraction {
  return Object.freeze({
    title: input.title,
    summary: input.summary,
    tasks: Object.freeze([...input.tasks]),
    followups: Object.freeze([...input.followups]),
    decisions: Object.freeze([...input.decisions]),
    entities: Object.freeze([...input.entities]),
    sourceQuotes: Object.freeze([...input.sourceQuotes]),
  });
}

function outputPaths(path: string): {
  readonly generated: string;
  readonly archive: string;
} {
  const basename = path.split("/").at(-1) ?? "capture.md";
  const stem = basename.replace(/\.md$/i, "");
  const slug = slugify(stem) || "capture";
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
  const name = `${slug}-${digest}.md`;
  return Object.freeze({
    generated: `wiki/generated/intake/${name}`,
    archive: `inbox/processed/${name}`,
  });
}

function renderGeneratedCapture(input: {
  readonly sourcePath: string;
  readonly archivePath: string;
  readonly extraction: CaptureExtraction;
}): string {
  const { extraction } = input;
  const lines: string[] = [
    "---",
    "type: capture",
    `sources: [${yamlString(`[[${input.archivePath}]]`)}]`,
    `processed_from: ${yamlString(input.sourcePath)}`,
    "---",
    "",
    `# ${extraction.title}`,
    "",
    extraction.summary,
    "",
  ];
  appendListSection(lines, "## Tasks", extraction.tasks, (item) => `- [ ] ${item}`);
  appendListSection(
    lines,
    "## Follow-ups",
    extraction.followups,
    (item) => `- [ ] #followup ${item}`,
  );
  appendListSection(lines, "## Decisions", extraction.decisions, (item) => `- ${item}`);
  appendListSection(lines, "## Entities", extraction.entities, (item) => `- [[${item}]]`);
  appendListSection(
    lines,
    "## Source Quotes",
    extraction.sourceQuotes,
    (item) => `> ${item}`,
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderArchive(input: {
  readonly sourcePath: string;
  readonly capture: string;
}): string {
  return [
    "---",
    "type: capture",
    `processed_from: ${yamlString(input.sourcePath)}`,
    "---",
    "",
    input.capture.trimEnd(),
    "",
  ].join("\n");
}

function appendListSection(
  lines: string[],
  heading: string,
  items: ReadonlyArray<string>,
  render: (item: string) => string,
): void {
  if (items.length === 0) return;
  lines.push(heading, "", ...items.map(render), "");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
