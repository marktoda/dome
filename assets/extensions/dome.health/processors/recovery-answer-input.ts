// Shared parser for dome.health answer-triggered recovery processors.

import {
  diagnosticEffect,
  type DiagnosticEffect,
} from "../../../../src/core/effect";
import {
  blobOid,
  commitOid,
  SourceRefSchema,
  sourceRef,
  type SourceRef,
} from "../../../../src/core/source-ref";

export type RecoveryAnswerInput = {
  readonly question: {
    readonly idempotencyKey: string;
    readonly sourceRefs: ReadonlyArray<SourceRef>;
  };
  readonly answer: string;
};

export function parseRecoveryAnswerInput(
  input: unknown,
): RecoveryAnswerInput | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const question = record.question;
  if (question === null || typeof question !== "object") return null;
  const questionRecord = question as Record<string, unknown>;
  if (typeof questionRecord.idempotencyKey !== "string") return null;
  if (typeof record.answer !== "string") return null;

  const refs = SourceRefSchema.array().safeParse(questionRecord.sourceRefs);
  if (!refs.success) return null;
  const sourceRefs = refs.data.map((ref) =>
    sourceRef({
      commit: commitOid(ref.commit),
      path: ref.path,
      ...(ref.blob !== undefined ? { blob: blobOid(ref.blob) } : {}),
      ...(ref.range !== undefined
        ? {
            range: {
              startLine: ref.range.startLine,
              endLine: ref.range.endLine,
              ...(ref.range.startChar !== undefined
                ? { startChar: ref.range.startChar }
                : {}),
              ...(ref.range.endChar !== undefined
                ? { endChar: ref.range.endChar }
                : {}),
            },
          }
        : {}),
      ...(ref.stableId !== undefined ? { stableId: ref.stableId } : {}),
    })
  );

  return Object.freeze({
    question: Object.freeze({
      idempotencyKey: questionRecord.idempotencyKey,
      sourceRefs: Object.freeze(sourceRefs),
    }),
    answer: record.answer,
  });
}

export function invalidRecoveryAnswerInputDiagnostic(opts: {
  readonly code: string;
  readonly message: string;
}): DiagnosticEffect {
  return diagnosticEffect({
    severity: "error",
    code: opts.code,
    message: opts.message,
    sourceRefs: [],
  });
}
