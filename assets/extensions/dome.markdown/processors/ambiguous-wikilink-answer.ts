// dome.markdown.ambiguous-wikilink-answer — applies answered link repairs.
//
// `validate-wikilinks` preserves ambiguous close-target repairs as
// source-backed questions. This answer handler closes that loop: if an agent
// or user picks one of the existing target options, patch only the original
// wikilink span through a normal garden sub-Proposal. Stale answers no-op so
// already-edited pages do not create surprise rewrites.

import {
  diagnosticEffect,
  patchEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

import { KEEP_UNRESOLVED_WIKILINK_ANSWER } from "./ambiguous-wikilink-shared";

const WIKILINK_SPAN_RE = /^\[\[([^\[\]\|]+?)(\|[^\[\]]+)?\]\]$/;

const ambiguousWikilinkAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.markdown.ambiguous-wikilink-answer.invalid-answer-input",
          message:
            "Ambiguous wikilink answer handler received an invalid answer envelope.",
          sourceRefs: [],
        }),
      ];
    }

    const answer = parseWikilinkAnswer(input.answer);
    if (answer === null || answer === KEEP_UNRESOLVED_WIKILINK_ANSWER) {
      return Object.freeze([]);
    }

    const sourceRef = firstPreciseSourceRef(input.question.sourceRefs);
    if (sourceRef === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.markdown.ambiguous-wikilink-answer.missing-source-range",
          message:
            "Ambiguous wikilink answer handler could not find the source wikilink range.",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    const content = await ctx.snapshot.readFile(sourceRef.path);
    if (content === null) return Object.freeze([]);

    const replacement = replaceWikilinkAtRange({
      content,
      sourceRef,
      answer,
    });
    if (replacement === null || replacement === content) {
      return Object.freeze([]);
    }

    return [
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: sourceRef.path,
            content: replacement,
          },
        ],
        reason:
          `dome.markdown: apply answered ambiguous wikilink repair in ${sourceRef.path}`,
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default ambiguousWikilinkAnswer;

type AnswerInput = {
  readonly question: {
    readonly sourceRefs: QuestionEffect["sourceRefs"];
  };
  readonly answer: string;
};

function parseAnswerInput(input: unknown): AnswerInput | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const question = record.question;
  if (question === null || typeof question !== "object") return null;
  const questionRecord = question as Record<string, unknown>;
  if (!Array.isArray(questionRecord.sourceRefs)) return null;
  if (typeof record.answer !== "string") return null;
  return Object.freeze({
    question: Object.freeze({
      sourceRefs:
        questionRecord.sourceRefs as AnswerInput["question"]["sourceRefs"],
    }),
    answer: record.answer,
  });
}

function parseWikilinkAnswer(answer: string): string | null {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === KEEP_UNRESOLVED_WIKILINK_ANSWER) return trimmed;
  if (
    trimmed.includes("[") ||
    trimmed.includes("]") ||
    trimmed.includes("|") ||
    trimmed.includes("\n")
  ) {
    return null;
  }
  return trimmed;
}

function firstPreciseSourceRef(
  sourceRefs: QuestionEffect["sourceRefs"],
): SourceRef | null {
  for (const ref of sourceRefs) {
    const range = ref.range;
    if (
      range?.startLine !== undefined &&
      range.endLine !== undefined &&
      range.startChar !== undefined &&
      range.endChar !== undefined &&
      range.startLine === range.endLine
    ) {
      return ref;
    }
  }
  return null;
}

function replaceWikilinkAtRange(input: {
  readonly content: string;
  readonly sourceRef: SourceRef;
  readonly answer: string;
}): string | null {
  const range = input.sourceRef.range;
  if (
    range === undefined ||
    range.startChar === undefined ||
    range.endChar === undefined
  ) {
    return null;
  }
  const start = offsetAt(input.content, range.startLine, range.startChar);
  const end = offsetAt(input.content, range.endLine, range.endChar);
  if (start === null || end === null || end <= start) return null;

  const span = input.content.slice(start, end);
  const match = WIKILINK_SPAN_RE.exec(span);
  if (match === null) return null;
  const displaySuffix = match[2] ?? "";
  const nextSpan = `[[${input.answer}${displaySuffix}]]`;
  if (nextSpan === span) return input.content;
  return `${input.content.slice(0, start)}${nextSpan}${input.content.slice(end)}`;
}

function offsetAt(
  content: string,
  line: number,
  char: number,
): number | null {
  if (line < 1 || char < 0) return null;
  let currentLine = 1;
  let lineStart = 0;
  while (currentLine < line) {
    const newline = content.indexOf("\n", lineStart);
    if (newline === -1) return null;
    lineStart = newline + 1;
    currentLine += 1;
  }
  const lineEnd = content.indexOf("\n", lineStart);
  const end = lineEnd === -1 ? content.length : lineEnd;
  const offset = lineStart + char;
  if (offset > end) return null;
  return offset;
}
