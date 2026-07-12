/**
 * Exact adopted-source document shared by the host and browser.
 *
 * This contract is intentionally dependency-free: both runtimes validate the
 * same small closed wire shape without pulling the engine or a schema library
 * into the PWA build.
 */
export const SOURCE_DOCUMENT_SCHEMA = "dome.source-document/v1" as const;

export type SourceDocument = {
  readonly schema: typeof SOURCE_DOCUMENT_SCHEMA;
  readonly status: "ok";
  readonly path: string;
  readonly commit: string;
  readonly content: string;
};

export type SourceDocumentProblemStatus =
  | "invalid-path"
  | "invalid-commit"
  | "not-adopted"
  | "not-found"
  | "too-large"
  | "unavailable";

export type SourceDocumentProblem = {
  readonly schema: typeof SOURCE_DOCUMENT_SCHEMA;
  readonly status: SourceDocumentProblemStatus;
  readonly message: string;
};

export type SourceDocumentResult = SourceDocument | SourceDocumentProblem;

/** Validate a source-document response at the protocol seam. */
export function parseSourceDocument(value: unknown): SourceDocumentResult {
  if (!isRecord(value) || value.schema !== SOURCE_DOCUMENT_SCHEMA || typeof value.status !== "string") {
    throw new Error(`source document must use ${SOURCE_DOCUMENT_SCHEMA}`);
  }
  if (value.status === "ok") {
    exactKeys(value, ["schema", "status", "path", "commit", "content"]);
    if (
      typeof value.path !== "string" || value.path.length === 0 ||
      typeof value.commit !== "string" || value.commit.length === 0 ||
      typeof value.content !== "string"
    ) {
      throw new Error("source document has invalid path, commit, or content");
    }
    return value as SourceDocument;
  }
  if (!PROBLEM_STATUSES.has(value.status)) {
    throw new Error("source document has an unknown status");
  }
  exactKeys(value, ["schema", "status", "message"]);
  if (typeof value.message !== "string" || value.message.length === 0) {
    throw new Error("source document problem must have a message");
  }
  return value as SourceDocumentProblem;
}

const PROBLEM_STATUSES: ReadonlySet<string> = new Set([
  "invalid-path",
  "invalid-commit",
  "not-adopted",
  "not-found",
  "too-large",
  "unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlyArray<string>): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("source document has unexpected fields");
  }
}
