import {
  SOURCE_DOCUMENT_SCHEMA,
  parseSourceDocument,
  type SourceDocumentResult,
} from "../../../contracts/source-document";

export type ExactCitation = {
  readonly path: string;
  readonly commit?: string | undefined;
};

/** Load one exact citation; this is deliberately separate from mutation auth. */
export async function fetchSourceDocument(
  citation: ExactCitation,
  signal?: AbortSignal,
): Promise<SourceDocumentResult> {
  if (citation.commit === undefined || citation.commit.length === 0) {
    return {
      schema: SOURCE_DOCUMENT_SCHEMA,
      status: "invalid-commit",
      message: "This answer did not include an exact source revision.",
    };
  }
  const query = new URLSearchParams({ path: citation.path, commit: citation.commit });
  const response = await fetch(`/source?${query.toString()}`, {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    ...(signal !== undefined ? { signal } : {}),
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("The source response was not valid JSON.");
  }
  const result = parseSourceDocument(value);
  if (
    result.status === "ok" &&
    (result.path !== citation.path || result.commit !== citation.commit.toLowerCase())
  ) {
    throw new Error("The source response did not match the requested citation.");
  }
  return result;
}
