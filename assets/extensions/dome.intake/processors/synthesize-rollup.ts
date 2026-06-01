// dome.intake.synthesize-rollup - synthesize recent generated captures.

import { createHash } from "node:crypto";

import matter from "gray-matter";
import { z } from "zod";

import {
  patchEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
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

const synthesizeRollup = defineProcessorImplementation({
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

    const inputHash = captureRollupInputHash(captures);
    const existing = await ctx.snapshot.readFile(OUTPUT_PATH);
    if (frontmatterInputHash(existing) === inputHash) return [];

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
            content: renderRollupPage({ captures, inputHash, rollup }),
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

export function captureRollupInputHash(
  captures: ReadonlyArray<{
    readonly path: string;
    readonly body: string;
    readonly lastChangedAt: string;
  }>,
): string {
  const hash = createHash("sha256");
  for (const capture of captures) {
    hash.update(capture.path);
    hash.update("\0");
    hash.update(capture.lastChangedAt);
    hash.update("\0");
    hash.update(capture.body);
    hash.update("\0");
  }
  return hash.digest("hex");
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
  readonly inputHash: string;
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
    `input_hash: ${input.inputHash}`,
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

function frontmatterInputHash(content: string | null): string | null {
  if (content === null) return null;
  try {
    const parsed = matter(content);
    const value = parsed.data.input_hash;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
