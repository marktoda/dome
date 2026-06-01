// dome.intake.extract-capture — compile raw inbox captures into markdown.

import {
  patchEffect,
  questionEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import { z } from "zod";
import {
  captureOutputPaths,
  captureSourceHash,
  renderIntakeItemsFrontmatter,
  type CapturePageItem,
  type CapturePageItemKind,
} from "./capture-page";
import {
  LOW_CONFIDENCE_QUESTION_OPTIONS,
  lowConfidenceQuestionKey,
  type CaptureLowConfidenceKind,
} from "./low-confidence-shared";

type CaptureExtraction = {
  readonly title: string;
  readonly summary: string;
  readonly tasks: ReadonlyArray<ExtractedItem>;
  readonly followups: ReadonlyArray<ExtractedItem>;
  readonly decisions: ReadonlyArray<ExtractedItem>;
  readonly entities: ReadonlyArray<ExtractedItem>;
  readonly sourceQuotes: ReadonlyArray<ExtractedItem>;
};

type ExtractedItem = {
  readonly text: string;
  readonly confidence: number;
};

const MODEL_SCHEMA = "dome.intake.extract-capture/v2";
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
    decisions: z.array(ExtractedItemSchema),
    entities: z.array(ExtractedItemSchema),
    sourceQuotes: z.array(ExtractedItemSchema),
  })
  .strict();

const extractCapture = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.modelInvoke === undefined) {
      throw new Error("dome.intake.extract-capture requires model.invoke");
    }

    const effects: Effect[] = [];
    for (const path of ctx.changedPaths.filter(isRawCapturePath).sort()) {
      const capture = await ctx.snapshot.readFile(path);
      if (capture === null) continue;
      const sourceHash = captureSourceHash(capture);

      const extraction = await ctx.modelInvoke.structured({
        schemaName: MODEL_SCHEMA,
        prompt: promptForCapture(path, capture),
        parse: parseCaptureExtraction,
      });
      const paths = captureOutputPaths({ path, sourceHash });
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
        ...lowConfidenceQuestions({
          path,
          sourceHash,
          generatedPath: paths.generated,
          sourceRef: ctx.sourceRef(path),
          extraction,
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
    "title:string, summary:string, tasks:item[], followups:item[], decisions:item[], entities:item[], sourceQuotes:item[].",
    "Each item may be a string for high confidence or {text:string, confidence:number}.",
    `Use confidence below ${CONFIDENCE_THRESHOLD} when the item is plausible but uncertain.`,
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
  readonly tasks: ReadonlyArray<ExtractedItem>;
  readonly followups: ReadonlyArray<ExtractedItem>;
  readonly decisions: ReadonlyArray<ExtractedItem>;
  readonly entities: ReadonlyArray<ExtractedItem>;
  readonly sourceQuotes: ReadonlyArray<ExtractedItem>;
}): CaptureExtraction {
  return Object.freeze({
    title: input.title,
    summary: input.summary,
    tasks: freezeItems(input.tasks),
    followups: freezeItems(input.followups),
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
  const decisions = highConfidenceItems("decision", extraction.decisions);
  const entities = highConfidenceItems("entity", extraction.entities);
  const sourceQuotes = highConfidenceItems(
    "source_quote",
    extraction.sourceQuotes,
  );
  const intakeItems = [
    ...tasks,
    ...followups,
    ...decisions,
    ...entities,
    ...sourceQuotes,
  ];
  const lines: string[] = [
    "---",
    "type: capture",
    `sources: [${yamlString(`[[${input.archivePath}]]`)}]`,
    ...renderIntakeItemsFrontmatter(intakeItems),
    `processed_from: ${yamlString(input.sourcePath)}`,
    `source_hash: ${yamlString(input.sourceHash)}`,
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

function lowConfidenceQuestions(input: {
  readonly path: string;
  readonly sourceHash: string;
  readonly generatedPath: string;
  readonly sourceRef: SourceRef;
  readonly extraction: CaptureExtraction;
}): ReadonlyArray<Effect> {
  const groups: ReadonlyArray<{
    readonly kind: CaptureLowConfidenceKind;
    readonly items: ReadonlyArray<ExtractedItem>;
    readonly question: (text: string) => string;
  }> = [
    {
      kind: "task",
      items: input.extraction.tasks,
      question: (text: string) =>
        `Low-confidence task from ${input.path}: "${text}". ` +
        "Should Dome track this as an open task?",
    },
    {
      kind: "followup",
      items: input.extraction.followups,
      question: (text: string) =>
        `Low-confidence follow-up from ${input.path}: "${text}". ` +
        "Should Dome track this as a follow-up?",
    },
    {
      kind: "decision",
      items: input.extraction.decisions,
      question: (text: string) =>
        `Low-confidence decision from ${input.path}: "${text}". ` +
        "Should Dome keep this as a decision?",
    },
    {
      kind: "entity",
      items: input.extraction.entities,
      question: (text: string) =>
        `Low-confidence entity from ${input.path}: "${text}". ` +
        "Should Dome keep this entity mention?",
    },
  ] as const;
  return Object.freeze(
    groups.flatMap((group) =>
      lowConfidenceItems(group.items).map((item) =>
        lowConfidenceQuestion({
          path: input.path,
          sourceHash: input.sourceHash,
          generatedPath: input.generatedPath,
          sourceRef: input.sourceRef,
          kind: group.kind,
          text: item.text,
          confidence: item.confidence,
          question: group.question(item.text),
        }),
      ),
    ),
  );
}

function lowConfidenceItems(
  items: ReadonlyArray<ExtractedItem>,
): ReadonlyArray<ExtractedItem> {
  return items.filter((item) => item.confidence < CONFIDENCE_THRESHOLD);
}

function lowConfidenceQuestion(input: {
  readonly path: string;
  readonly sourceHash: string;
  readonly generatedPath: string;
  readonly sourceRef: SourceRef;
  readonly kind: CaptureLowConfidenceKind;
  readonly text: string;
  readonly confidence: number;
  readonly question: string;
}): Effect {
  return questionEffect({
    question: input.question,
    options: LOW_CONFIDENCE_QUESTION_OPTIONS,
    sourceRefs: [input.sourceRef],
    idempotencyKey: lowConfidenceQuestionKey({
      version: 1,
      path: input.path,
      sourceHash: input.sourceHash,
      generatedPath: input.generatedPath,
      kind: input.kind,
      text: input.text,
      confidence: input.confidence,
    }),
    metadata: {
      risk: "low",
      confidence: input.confidence,
      recommendedAnswer: "track",
      automationPolicy: "agent-safe",
    },
  });
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
