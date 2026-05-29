// dome.intake.synthesize-rollup - synthesize recent generated captures.

import { z } from "zod";

import {
  patchEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

type CaptureInput = {
  readonly path: string;
  readonly body: string;
  readonly lastChangedAt: string;
};

type CaptureRollup = {
  readonly title: string;
  readonly thesis: string;
  readonly themes: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
  readonly nextSteps: ReadonlyArray<string>;
};

const MODEL_SCHEMA = "dome.intake.synthesize-rollup/v1";
const OUTPUT_PATH = "wiki/syntheses/intake-rollup.md";
const MAX_CAPTURE_FILES = 12;
const MAX_CAPTURE_CHARS = 4_000;

const NonEmptyTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "expected non-empty string");
const CaptureRollupSchema = z
  .object({
    title: NonEmptyTrimmedString,
    thesis: NonEmptyTrimmedString,
    themes: z.array(NonEmptyTrimmedString),
    risks: z.array(NonEmptyTrimmedString),
    nextSteps: z.array(NonEmptyTrimmedString),
  })
  .strict();

const synthesizeRollup: Processor = defineProcessor({
  id: "dome.intake.synthesize-rollup",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "signal",
      name: "file.created",
      pathPattern: "wiki/generated/intake/*.md",
    },
    {
      kind: "signal",
      name: "document.changed",
      pathPattern: "wiki/generated/intake/*.md",
    },
    {
      kind: "signal",
      name: "file.deleted",
      pathPattern: "wiki/generated/intake/*.md",
    },
  ],
  capabilities: [
    { kind: "read", paths: ["wiki/generated/intake/*.md"] },
    { kind: "patch.auto", paths: [OUTPUT_PATH] },
    { kind: "model.invoke", maxDailyCostUsd: 5 },
  ],
  execution: {
    class: "llm",
    timeoutMs: 600_000,
    modelCallTimeoutMs: 180_000,
  },
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.modelInvoke === undefined) {
      throw new Error("dome.intake.synthesize-rollup requires model.invoke");
    }
    if (!ctx.changedPaths.some(isGeneratedCapturePath)) return [];

    const captures = await recentGeneratedCaptures(ctx);
    if (captures.length === 0) {
      const sourceRefs = ctx.changedPaths
        .filter(isGeneratedCapturePath)
        .sort()
        .map((path) => ctx.sourceRef(path));
      if (sourceRefs.length === 0) return [];
      return Object.freeze([
        patchEffect({
          mode: "auto",
          changes: [{ kind: "delete", path: OUTPUT_PATH }],
          reason: "dome.intake: remove empty recent captures rollup",
          sourceRefs,
        }),
      ]);
    }

    const rollup = await ctx.modelInvoke.structured({
      schemaName: MODEL_SCHEMA,
      prompt: promptForCaptures(captures),
      parse: parseCaptureRollup,
    });

    return Object.freeze([
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: OUTPUT_PATH,
            content: renderRollupPage({ captures, rollup }),
          },
        ],
        reason: "dome.intake: synthesize recent captures rollup",
        sourceRefs: captures.map((capture) => ctx.sourceRef(capture.path)),
      }),
    ]);
  },
});

export default synthesizeRollup;

export function rollupOutputPath(): string {
  return OUTPUT_PATH;
}

async function recentGeneratedCaptures(
  ctx: ProcessorContext,
): Promise<ReadonlyArray<CaptureInput>> {
  const paths = (await ctx.snapshot.listMarkdownFiles())
    .filter(isGeneratedCapturePath)
    .sort();
  const captures: CaptureInput[] = [];
  for (const path of paths) {
    const body = await ctx.snapshot.readFile(path);
    if (body === null) continue;
    const info = await ctx.snapshot.getFileInfo(path);
    captures.push({
      path,
      body: body.slice(0, MAX_CAPTURE_CHARS),
      lastChangedAt: info?.lastChangedAt ?? "",
    });
  }
  return Object.freeze(
    captures
      .sort(compareCaptureRecency)
      .slice(0, MAX_CAPTURE_FILES),
  );
}

function compareCaptureRecency(a: CaptureInput, b: CaptureInput): number {
  const byDate = b.lastChangedAt.localeCompare(a.lastChangedAt);
  return byDate === 0 ? a.path.localeCompare(b.path) : byDate;
}

function isGeneratedCapturePath(path: string): boolean {
  return /^wiki\/generated\/intake\/[^/]+\.md$/.test(path);
}

function promptForCaptures(captures: ReadonlyArray<CaptureInput>): string {
  return [
    "Synthesize recent Dome generated intake captures into strict JSON.",
    "Return only JSON with keys:",
    "title:string, thesis:string, themes:string[], risks:string[], nextSteps:string[].",
    "Use only claims supported by the capture text.",
    "Themes should summarize recurring management, people, project, and " +
      "decision signal.",
    "Risks should capture blockers, ambiguity, unowned work, or follow-up risk.",
    "Next steps should be concrete actions or investigation prompts.",
    "",
    ...captures.flatMap((capture) => [
      `Capture path: ${capture.path}`,
      `Last changed: ${capture.lastChangedAt || "unknown"}`,
      capture.body,
      "",
    ]),
  ].join("\n");
}

function parseCaptureRollup(value: unknown): CaptureRollup {
  const parsed = CaptureRollupSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return Object.freeze({
    title: parsed.data.title,
    thesis: parsed.data.thesis,
    themes: freezeStrings(parsed.data.themes),
    risks: freezeStrings(parsed.data.risks),
    nextSteps: freezeStrings(parsed.data.nextSteps),
  });
}

function renderRollupPage(input: {
  readonly captures: ReadonlyArray<CaptureInput>;
  readonly rollup: CaptureRollup;
}): string {
  const { rollup } = input;
  const lines: string[] = [
    "---",
    "type: synthesis",
    "sources:",
    ...input.captures.map(
      (capture) => `  - ${yamlString(`[[${capture.path}]]`)}`,
    ),
    "processor: dome.intake.synthesize-rollup",
    "---",
    "",
    `# ${rollup.title}`,
    "",
    rollup.thesis,
    "",
  ];
  appendStringSection(lines, "## Themes", rollup.themes);
  appendStringSection(lines, "## Risks", rollup.risks);
  appendStringSection(lines, "## Next Steps", rollup.nextSteps);
  lines.push(
    "## Sources",
    "",
    ...input.captures.map((capture) => `- [[${capture.path}]]`),
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

function appendStringSection(
  lines: string[],
  heading: string,
  items: ReadonlyArray<string>,
): void {
  if (items.length === 0) return;
  lines.push(heading, "", ...items.map((item) => `- ${item}`), "");
}

function freezeStrings(items: ReadonlyArray<string>): ReadonlyArray<string> {
  return Object.freeze([...items]);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
