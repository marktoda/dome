// dome.markdown.duplicate-detection-answer — records source-preserving
// duplicate consolidation decisions.

import { createHash } from "node:crypto";
import { posix } from "node:path";

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

import {
  DUPLICATE_DETECTION_QUESTION_PREFIX,
  DUPLICATE_KEEP_SEPARATE_ANSWER,
  DUPLICATE_MERGE_ANSWER,
} from "./duplicate-detection-shared";

import { compareStrings } from "../../../../src/core/compare";

const duplicateDetectionAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.markdown.duplicate-detection-answer.invalid-answer-input",
          message:
            "Duplicate-detection answer handler received an invalid answer envelope.",
          sourceRefs: [],
        }),
      ];
    }

    const answer = parseDuplicateAnswer(input.answer);
    if (
      answer === null ||
      answer === DUPLICATE_KEEP_SEPARATE_ANSWER ||
      !input.question.idempotencyKey.startsWith(
        DUPLICATE_DETECTION_QUESTION_PREFIX,
      )
    ) {
      return Object.freeze([]);
    }

    const paths = duplicateSourcePaths(input.question.sourceRefs);
    if (paths === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.markdown.duplicate-detection-answer.invalid-source-pair",
          message:
            "Duplicate-detection answer handler expected exactly two markdown source pages.",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    const review = duplicateReviewForQuestion({
      paths,
      idempotencyKey: input.question.idempotencyKey,
    });
    const existing = await ctx.snapshot.readFile(review.path);
    if (existing !== null) return Object.freeze([]);

    const canonicalContent = await ctx.snapshot.readFile(review.canonical);
    const duplicateContent = await ctx.snapshot.readFile(review.duplicate);
    if (canonicalContent === null || duplicateContent === null) {
      return [
        diagnosticEffect({
          severity: "warning",
          code: "dome.markdown.duplicate-detection-answer.stale-source-pair",
          message:
            "Duplicate-detection answer handler could not create a review because one source page no longer exists.",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    return [
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: review.path,
            content: renderDuplicateReviewPage(review),
          },
        ],
        reason:
          "dome.markdown: record source-preserving duplicate consolidation review",
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default duplicateDetectionAnswer;

export type DuplicateReview = {
  readonly path: string;
  readonly canonical: string;
  readonly duplicate: string;
  readonly paths: readonly [string, string];
  readonly title: string;
  readonly idempotencyKey: string;
};

export function duplicateReviewForQuestion(input: {
  readonly paths: readonly [string, string];
  readonly idempotencyKey: string;
}): DuplicateReview {
  const [canonical, duplicate] = canonicalDuplicatePair(input.paths);
  const title = titleFromPath(canonical);
  const slug = slugify(posix.basename(canonical, ".md")) || "duplicate-review";
  const digest = sha256(input.idempotencyKey).slice(0, 12);
  return Object.freeze({
    path: `wiki/syntheses/duplicate-review-${slug}-${digest}.md`,
    canonical,
    duplicate,
    paths: input.paths,
    title,
    idempotencyKey: input.idempotencyKey,
  });
}

type AnswerInput = {
  readonly question: {
    readonly idempotencyKey: string;
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
  if (typeof questionRecord.idempotencyKey !== "string") return null;
  if (!Array.isArray(questionRecord.sourceRefs)) return null;
  if (typeof record.answer !== "string") return null;
  return Object.freeze({
    question: Object.freeze({
      idempotencyKey: questionRecord.idempotencyKey,
      sourceRefs:
        questionRecord.sourceRefs as AnswerInput["question"]["sourceRefs"],
    }),
    answer: record.answer,
  });
}

function parseDuplicateAnswer(answer: string): string | null {
  const trimmed = answer.trim();
  if (
    trimmed === DUPLICATE_MERGE_ANSWER ||
    trimmed === DUPLICATE_KEEP_SEPARATE_ANSWER
  ) {
    return trimmed;
  }
  return null;
}

function duplicateSourcePaths(
  sourceRefs: QuestionEffect["sourceRefs"],
): readonly [string, string] | null {
  const paths = [...new Set(sourceRefs.map((ref) => ref.path))]
    .filter((path) => path.endsWith(".md"))
    .sort();
  if (paths.length !== 2) return null;
  const [first, second] = paths;
  if (first === undefined || second === undefined) return null;
  return Object.freeze([first, second]);
}

function canonicalDuplicatePair(
  paths: readonly [string, string],
): readonly [string, string] {
  const sorted = [...paths].sort(compareCanonicalCandidates);
  const canonical = sorted[0] ?? paths[0];
  const duplicate = sorted[1] ?? paths[1];
  return Object.freeze([canonical, duplicate]);
}

function compareCanonicalCandidates(a: string, b: string): number {
  const score = canonicalScore(a) - canonicalScore(b);
  if (score !== 0) return score;
  const length = a.length - b.length;
  if (length !== 0) return length;
  return compareStrings(a, b);
}

function canonicalScore(path: string): number {
  let score = 0;
  if (!path.startsWith("wiki/")) score += 10;
  const stem = normalizePathStem(path);
  if (/\b(copy|draft|old|tmp|temp)\b/.test(stem)) score += 3;
  return score;
}

function renderDuplicateReviewPage(review: DuplicateReview): string {
  const canonicalLink = wikilink(review.canonical);
  const duplicateLink = wikilink(review.duplicate);
  return [
    "---",
    "type: synthesis",
    "sources:",
    `  - ${yamlString(canonicalLink)}`,
    `  - ${yamlString(duplicateLink)}`,
    "description: \"Source-preserving duplicate consolidation review.\"",
    "metadata:",
    "  duplicate_review:",
    `    canonical: ${yamlString(review.canonical)}`,
    `    duplicate: ${yamlString(review.duplicate)}`,
    `    question: ${yamlString(review.idempotencyKey)}`,
    `name: ${yamlString(`Duplicate review: ${review.title}`)}`,
    "status: draft",
    "---",
    "",
    `# Duplicate review: ${review.title}`,
    "",
    `Canonical candidate: ${canonicalLink}`,
    "",
    `Duplicate candidate: ${duplicateLink}`,
    "",
    "A `merge` answer was recorded for a duplicate-detection question. No source content was deleted.",
    "",
    "## Source Pages",
    "",
    `- ${canonicalLink}`,
    `- ${duplicateLink}`,
    "",
    "## Consolidation Notes",
    "",
    "- Move unique source-backed material into the canonical page.",
    "- Preserve useful aliases and backlinks before retiring either page.",
    "",
  ].join("\n");
}

function wikilink(path: string): string {
  return `[[${path.replace(/\.md$/i, "")}]]`;
}

function titleFromPath(path: string): string {
  return posix
    .basename(path, ".md")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\p{L}/gu, (match) => match.toUpperCase());
}

function normalizePathStem(path: string): string {
  return posix
    .basename(path, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
