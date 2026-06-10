import { z } from "zod";

import {
  blobOid,
  commitOid,
  sourceRef,
  SourceRefSchema,
  type TextRange,
  type SourceRef,
  type SourceRefInput,
} from "../core/source-ref";

export function parseJsonColumn<S extends z.ZodType>(
  raw: string,
  label: string,
  schema: S,
): z.output<S> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${label} contains invalid JSON: ${message}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${label} failed validation: ${formatZodIssues(result.error)}`);
  }
  return result.data;
}

export function parseOptionalJsonColumn<S extends z.ZodType>(
  raw: string | null,
  label: string,
  schema: S,
): z.output<S> | undefined {
  return raw === null ? undefined : parseJsonColumn(raw, label, schema);
}

export function parseSourceRefsColumn(
  raw: string,
  label: string,
): ReadonlyArray<SourceRef> {
  const refs = parseJsonColumn(raw, label, z.array(SourceRefSchema));
  return Object.freeze(
    refs.map((ref) => {
      const input: {
        -readonly [K in keyof SourceRefInput]: SourceRefInput[K];
      } = {
        commit: commitOid(ref.commit),
        path: ref.path,
      };
      if (ref.blob !== undefined) input.blob = blobOid(ref.blob);
      if (ref.range !== undefined) input.range = textRange(ref.range);
      if (ref.stableId !== undefined) input.stableId = ref.stableId;
      return sourceRef(input);
    }),
  );
}

function textRange(raw: {
  readonly startLine: number;
  readonly endLine: number;
  readonly startChar?: number | undefined;
  readonly endChar?: number | undefined;
}): TextRange {
  const range: { -readonly [K in keyof TextRange]: TextRange[K] } = {
    startLine: raw.startLine,
    endLine: raw.endLine,
  };
  if (raw.startChar !== undefined) range.startChar = raw.startChar;
  if (raw.endChar !== undefined) range.endChar = raw.endChar;
  return Object.freeze(range);
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}
