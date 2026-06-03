// dome.intake.synthesize-capture — turn generated captures into synthesis pages.

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

type CaptureSynthesis = {
  readonly title: string;
  readonly thesis: string;
  readonly highlights: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
  readonly nextSteps: ReadonlyArray<string>;
};

const MODEL_SCHEMA = "dome.intake.synthesize-capture/v1";
const NonEmptyTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "expected non-empty string");
const CaptureSynthesisSchema = z
  .object({
    title: NonEmptyTrimmedString,
    thesis: NonEmptyTrimmedString,
    highlights: z.array(NonEmptyTrimmedString),
    risks: z.array(NonEmptyTrimmedString),
    nextSteps: z.array(NonEmptyTrimmedString),
  })
  .strict();

const synthesizeCapture = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths.filter(isGeneratedCapturePath).sort()) {
      const capture = await ctx.snapshot.readFile(path);
      const outputPath = synthesisOutputPath(path);
      if (capture === null) {
        if ((await ctx.snapshot.readFile(outputPath)) !== null) {
          effects.push(
            patchEffect({
              mode: "auto",
              changes: [
                {
                  kind: "delete",
                  path: outputPath,
                },
              ],
              reason:
                `dome.intake: remove stale synthesis ${outputPath} after ` +
                `${path} was deleted`,
              sourceRefs: [ctx.sourceRef(outputPath)],
            }),
          );
        }
        continue;
      }

      if (ctx.modelInvoke === undefined) {
        throw new Error("dome.intake.synthesize-capture requires model.invoke");
      }

      const inputHash = captureSynthesisInputHash(capture);
      const existing = await ctx.snapshot.readFile(outputPath);
      if (frontmatterInputHash(existing) === inputHash) continue;

      const synthesis = await ctx.modelInvoke.structured({
        schemaName: MODEL_SCHEMA,
        prompt: promptForCapture(path, capture),
        parse: parseCaptureSynthesis,
      });
      effects.push(
        patchEffect({
          mode: "auto",
          changes: [
            {
              kind: "write",
              path: outputPath,
              content: renderSynthesisPage({
                inputHash,
                sourcePath: path,
                synthesis,
              }),
            },
          ],
          reason: `dome.intake: synthesize capture ${path}`,
          sourceRefs: [ctx.sourceRef(path)],
        }),
      );
    }
    return Object.freeze(effects);
  },
});

export default synthesizeCapture;

export function synthesisOutputPath(path: string): string {
  const basename = path.split("/").at(-1) ?? "capture.md";
  const stem = basename.replace(/\.md$/i, "");
  const slug = stripStableDigest(slugify(stem)) || "capture";
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
  return `wiki/syntheses/intake-${slug}-${digest}.md`;
}

export function captureSynthesisInputHash(capture: string): string {
  return createHash("sha256").update(capture).digest("hex");
}

function isGeneratedCapturePath(path: string): boolean {
  return /^wiki\/generated\/intake\/[^/]+\.md$/.test(path);
}

function promptForCapture(path: string, capture: string): string {
  return [
    "Synthesize a Dome generated intake capture into strict JSON.",
    "Return only JSON with keys:",
    "title:string, thesis:string, highlights:string[], risks:string[], nextSteps:string[].",
    "Use only claims supported by the capture text.",
    "Highlights should capture useful management/project signal.",
    "Risks should capture blockers, ambiguities, or follow-up risks.",
    "Next steps should be concrete actions or investigation prompts.",
    "",
    `Capture path: ${path}`,
    "",
    capture,
  ].join("\n");
}

function parseCaptureSynthesis(value: unknown): CaptureSynthesis {
  const parsed = CaptureSynthesisSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  return Object.freeze({
    title: parsed.data.title,
    thesis: parsed.data.thesis,
    highlights: freezeStrings(parsed.data.highlights),
    risks: freezeStrings(parsed.data.risks),
    nextSteps: freezeStrings(parsed.data.nextSteps),
  });
}

function renderSynthesisPage(input: {
  readonly inputHash: string;
  readonly sourcePath: string;
  readonly synthesis: CaptureSynthesis;
}): string {
  const { synthesis } = input;
  const lines: string[] = [
    "---",
    "type: synthesis",
    `sources: [${yamlString(`[[${input.sourcePath}]]`)}]`,
    `generated_from: ${yamlString(input.sourcePath)}`,
    `input_hash: ${input.inputHash}`,
    "processor: dome.intake.synthesize-capture",
    "---",
    "",
    `# ${synthesis.title}`,
    "",
    synthesis.thesis,
    "",
  ];
  appendStringSection(lines, "## Highlights", synthesis.highlights);
  appendStringSection(lines, "## Risks", synthesis.risks);
  appendStringSection(lines, "## Next Steps", synthesis.nextSteps);
  lines.push("## Source", "", `- [[${input.sourcePath}]]`, "");
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function stripStableDigest(value: string): string {
  return value.replace(/-[a-f0-9]{12}$/i, "");
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
