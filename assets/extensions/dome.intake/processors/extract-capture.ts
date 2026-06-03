// dome.intake.extract-capture — compile raw inbox captures into markdown.

import {
  patchEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import { z } from "zod";
import {
  currentCaptureDigest,
  captureOutputPaths,
  captureSourceHash,
  renderIntakeItemsFrontmatter,
  renderPendingItemsFrontmatter,
  type CapturePageItem,
  type CapturePageItemKind,
  type CapturePendingItem,
} from "./capture-page";
import {
  lowConfidenceQuestionEffect,
  type CaptureLowConfidenceKind,
} from "./low-confidence-shared";

type CaptureExtraction = {
  readonly title: string;
  readonly summary: string;
  readonly tasks: ReadonlyArray<ExtractedItem>;
  readonly followups: ReadonlyArray<ExtractedItem>;
  readonly questions: ReadonlyArray<ExtractedItem>;
  readonly decisions: ReadonlyArray<ExtractedItem>;
  readonly entities: ReadonlyArray<ExtractedItem>;
  readonly sourceQuotes: ReadonlyArray<ExtractedItem>;
};

type ExtractedItem = {
  readonly text: string;
  readonly confidence: number;
};

const MODEL_SCHEMA = "dome.intake.extract-capture/v3";
const PROCESSOR_ID = "dome.intake.extract-capture";
const CONFIG_PATH = ".dome/config.yaml";
const MODEL_PROVIDER_PATH = ".dome/model-provider.ts";
const CONFIDENCE_THRESHOLD = 0.82;
const NonEmptyTrimmedString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "expected non-empty string");
const ExtractedItemSchema = z.union([
  NonEmptyTrimmedString.transform((text) => ({ text, confidence: 1 })),
  z
    .object({
      text: NonEmptyTrimmedString,
      confidence: z.number().min(0).max(1).optional(),
    })
    .strict()
    .transform((item) => ({
      text: item.text,
      confidence: item.confidence ?? 1,
    })),
]);
const CaptureExtractionSchema = z
  .object({
    title: NonEmptyTrimmedString,
    summary: NonEmptyTrimmedString,
    tasks: z.array(ExtractedItemSchema),
    followups: z.array(ExtractedItemSchema),
    questions: z.array(ExtractedItemSchema).optional().default([]),
    decisions: z.array(ExtractedItemSchema),
    entities: z.array(ExtractedItemSchema),
    sourceQuotes: z.array(ExtractedItemSchema),
  })
  .strict();

const extractCapture = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const rawCapturePaths = await rawCapturePathsForRun(ctx);
    if (rawCapturePaths.length === 0) return Object.freeze([]);

    if (ctx.modelInvoke === undefined) {
      throw new Error("dome.intake.extract-capture requires model.invoke");
    }

    const effects: Effect[] = [];
    for (const path of rawCapturePaths) {
      const capture = await ctx.snapshot.readFile(path);
      if (capture === null) continue;
      const sourceHash = captureSourceHash(capture);
      const paths = captureOutputPaths({ path, sourceHash });
      const generatedContent = await ctx.snapshot.readFile(paths.generated);
      const archiveContent = await ctx.snapshot.readFile(paths.archive);
      const current = currentCaptureDigest({
        generatedContent,
        archiveContent,
        sourcePath: path,
        sourceHash,
        processor: PROCESSOR_ID,
        extractionSchema: MODEL_SCHEMA,
        capture,
      });

      if (current !== null) {
        effects.push(
          patchEffect({
            mode: "auto",
            changes: [
              {
                kind: "delete",
                path,
              },
            ],
            reason: `dome.intake: clear already-digested capture ${path}`,
            sourceRefs: [ctx.sourceRef(path), ctx.sourceRef(paths.archive)],
          }),
          ...lowConfidenceQuestionsFromPending({
            path,
            sourceHash,
            generatedPath: paths.generated,
            pendingItems: current.pendingItems,
            sourceRefs: [
              ctx.sourceRef(path),
              ctx.sourceRef(paths.generated),
            ],
          }),
        );
        continue;
      }

      const extraction = await ctx.modelInvoke.structured({
        schemaName: MODEL_SCHEMA,
        prompt: promptForCapture(path, capture),
        parse: parseCaptureExtraction,
      });
      const archive = renderArchive({ sourcePath: path, sourceHash, capture });
      const generated = renderGeneratedCapture({
        sourcePath: path,
        sourceHash,
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

async function rawCapturePathsForRun(
  ctx: ProcessorContext,
): Promise<ReadonlyArray<string>> {
  const changedRaw = ctx.changedPaths.filter(isRawCapturePath);
  if (isScheduleInput(ctx.input) || isActivationRun(ctx)) {
    return sortedUnique(
      (await ctx.snapshot.listMarkdownFiles()).filter(isRawCapturePath),
    );
  }
  return sortedUnique(changedRaw);
}

function isScheduleInput(input: unknown): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    (input as { readonly kind?: unknown }).kind === "schedule"
  );
}

function isActivationRun(ctx: ProcessorContext): boolean {
  return (
    ctx.changedPaths.some(isActivationPath) ||
    matchedSignalPaths(ctx.input).some(isActivationPath)
  );
}

function isActivationPath(path: string): boolean {
  return path === CONFIG_PATH || path === MODEL_PROVIDER_PATH;
}

function isRawCapturePath(path: string): boolean {
  return /^inbox\/raw\/[^/]+\.md$/.test(path);
}

function matchedSignalPaths(input: unknown): ReadonlyArray<string> {
  if (!isRecord(input) || !Array.isArray(input.matchedTriggers)) {
    return Object.freeze([]);
  }

  const paths: string[] = [];
  for (const match of input.matchedTriggers) {
    if (!isRecord(match) || !Array.isArray(match.matchedSignals)) continue;
    for (const signal of match.matchedSignals) {
      if (!isRecord(signal) || typeof signal.path !== "string") continue;
      paths.push(signal.path);
    }
  }
  return Object.freeze(paths);
}

function sortedUnique(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return Object.freeze([...new Set(paths)].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function promptForCapture(path: string, capture: string): string {
  return [
    "Extract a Dome capture into strict JSON.",
    "Return only JSON with keys:",
    "title:string, summary:string, tasks:item[], followups:item[], questions:item[], decisions:item[], entities:item[], sourceQuotes:item[].",
    "Each item may be a string for high confidence or {text:string, confidence:number}.",
    `Use confidence below ${CONFIDENCE_THRESHOLD} when the item is plausible but uncertain.`,
    "Tasks should be concrete open action items.",
    "Followups should be people/project follow-up actions.",
    "Questions should be explicit unresolved questions from the capture.",
    "Decisions should be explicit decisions from the capture.",
    "Source quotes should be short exact excerpts from the capture.",
    "Do not turn questions into tasks.",
    "Do not turn expected system behavior, validation criteria, or descriptions of Dome processing into tasks or followups unless the capture says someone still needs to do that work after the capture.",
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
    questions: parsed.data.questions,
    decisions: parsed.data.decisions,
    entities: parsed.data.entities,
    sourceQuotes: parsed.data.sourceQuotes,
  });
}

function deepFreezeExtraction(input: {
  readonly title: string;
  readonly summary: string;
  readonly tasks: ReadonlyArray<ExtractedItem>;
  readonly followups: ReadonlyArray<ExtractedItem>;
  readonly questions: ReadonlyArray<ExtractedItem>;
  readonly decisions: ReadonlyArray<ExtractedItem>;
  readonly entities: ReadonlyArray<ExtractedItem>;
  readonly sourceQuotes: ReadonlyArray<ExtractedItem>;
}): CaptureExtraction {
  return Object.freeze({
    title: input.title,
    summary: input.summary,
    tasks: freezeItems(input.tasks),
    followups: freezeItems(input.followups),
    questions: freezeItems(input.questions),
    decisions: freezeItems(input.decisions),
    entities: freezeItems(input.entities),
    sourceQuotes: freezeItems(input.sourceQuotes),
  });
}

function freezeItems(
  items: ReadonlyArray<ExtractedItem>,
): ReadonlyArray<ExtractedItem> {
  return Object.freeze(
    items.map((item) =>
      Object.freeze({
        text: item.text,
        confidence: item.confidence,
      }),
    ),
  );
}

function renderGeneratedCapture(input: {
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly archivePath: string;
  readonly extraction: CaptureExtraction;
}): string {
  const { extraction } = input;
  const tasks = highConfidenceItems("task", extraction.tasks);
  const followups = highConfidenceItems("followup", extraction.followups);
  const questions = highConfidenceItems("question", extraction.questions);
  const decisions = highConfidenceItems("decision", extraction.decisions);
  const entities = highConfidenceItems("entity", extraction.entities);
  const sourceQuotes = highConfidenceItems(
    "source_quote",
    extraction.sourceQuotes,
  );
  const pendingItems = pendingCaptureItems(extraction);
  const intakeItems = [
    ...tasks,
    ...followups,
    ...questions,
    ...decisions,
    ...entities,
    ...sourceQuotes,
  ];
  const lines: string[] = [
    "---",
    "type: capture",
    `sources: [${yamlString(`[[${input.archivePath}]]`)}]`,
    ...renderIntakeItemsFrontmatter(intakeItems),
    ...renderPendingItemsFrontmatter(pendingItems),
    `processed_from: ${yamlString(input.sourcePath)}`,
    `source_hash: ${yamlString(input.sourceHash)}`,
    `processor: ${PROCESSOR_ID}`,
    `extraction_schema: ${yamlString(MODEL_SCHEMA)}`,
    "disposition: digested",
    "---",
    "",
    `# ${extraction.title}`,
    "",
    extraction.summary,
    "",
  ];
  appendListSection(lines, "## Tasks", tasks, (item) => `- [ ] ${item.text}`);
  appendListSection(
    lines,
    "## Follow-ups",
    followups,
    (item) => `- [ ] #followup ${item.text}`,
  );
  appendListSection(
    lines,
    "## Questions",
    questions,
    (item) => `- ${item.text}`,
  );
  appendListSection(
    lines,
    "## Decisions",
    decisions,
    (item) => `- ${item.text}`,
  );
  appendListSection(
    lines,
    "## Entities",
    entities,
    (item) => `- ${item.text}`,
  );
  appendListSection(
    lines,
    "## Source Quotes",
    sourceQuotes,
    (item) => `> ${item.text}`,
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

function highConfidenceItems(
  kind: CapturePageItemKind,
  items: ReadonlyArray<ExtractedItem>,
): ReadonlyArray<CapturePageItem> {
  return Object.freeze(
    items
      .filter((item) => item.confidence >= CONFIDENCE_THRESHOLD)
      .map((item) =>
        Object.freeze({
          kind,
          text: item.text,
          confidence: item.confidence,
        }),
      ),
  );
}

function pendingCaptureItems(
  extraction: CaptureExtraction,
): ReadonlyArray<CapturePendingItem> {
  return Object.freeze([
    ...lowConfidenceItems("task", extraction.tasks),
    ...lowConfidenceItems("followup", extraction.followups),
    ...lowConfidenceItems("question", extraction.questions),
    ...lowConfidenceItems("decision", extraction.decisions),
    ...lowConfidenceItems("entity", extraction.entities),
  ]);
}

function lowConfidenceQuestionsFromPending(input: {
  readonly path: string;
  readonly sourceHash: string;
  readonly generatedPath: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly pendingItems: ReadonlyArray<CapturePendingItem>;
}): ReadonlyArray<Effect> {
  return Object.freeze(
    input.pendingItems.map((item) =>
      lowConfidenceQuestionEffect({
        path: input.path,
        sourceHash: input.sourceHash,
        generatedPath: input.generatedPath,
        kind: item.kind,
        text: item.text,
        confidence: item.confidence,
        sourceRefs: input.sourceRefs,
      }),
    ),
  );
}

function lowConfidenceItems(
  kind: CaptureLowConfidenceKind,
  items: ReadonlyArray<ExtractedItem>,
): ReadonlyArray<CapturePendingItem> {
  return Object.freeze(
    items
      .filter((item) => item.confidence < CONFIDENCE_THRESHOLD)
      .map((item) =>
        Object.freeze({
          kind,
          text: item.text,
          confidence: item.confidence,
        }),
      ),
  );
}

function renderArchive(input: {
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly capture: string;
}): string {
  return [
    "---",
    "type: capture",
    `processed_from: ${yamlString(input.sourcePath)}`,
    `source_hash: ${yamlString(input.sourceHash)}`,
    `processor: ${PROCESSOR_ID}`,
    `extraction_schema: ${yamlString(MODEL_SCHEMA)}`,
    "disposition: archived",
    "---",
    "",
    input.capture.trimEnd(),
    "",
  ].join("\n");
}

function appendListSection(
  lines: string[],
  heading: string,
  items: ReadonlyArray<CapturePageItem>,
  render: (item: CapturePageItem) => string,
): void {
  if (items.length === 0) return;
  lines.push(heading, "", ...items.map(render), "");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
