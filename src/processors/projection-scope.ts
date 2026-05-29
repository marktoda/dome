import type {
  FactEffect,
  NodeRef,
} from "../core/effect";
import type {
  ProjectionQueryView,
  SearchDocumentResult,
} from "../core/processor";
import type { SourceRef } from "../core/source-ref";

export type CanReadVaultPath = (path: string) => boolean;

export function scopeProjectionQueryView(
  projection: ProjectionQueryView,
  canReadPath: CanReadVaultPath,
): ProjectionQueryView {
  return Object.freeze({
    facts: (filter) =>
      Object.freeze(
        projection.facts(filter).filter((fact) =>
          factVisible(fact, canReadPath),
        ),
      ),
    diagnostics: (filter) =>
      Object.freeze(
        projection.diagnostics(filter).filter((diagnostic) =>
          sourceRefsVisible(diagnostic.sourceRefs, canReadPath),
        ),
      ),
    questions: (filter) =>
      Object.freeze(
        projection.questions(filter).filter((question) =>
          sourceRefsVisible(question.sourceRefs, canReadPath),
        ),
      ),
    searchDocuments: (filter) =>
      Object.freeze(
        projection.searchDocuments(filter).filter((result) =>
          searchResultVisible(result, canReadPath),
        ),
      ),
  });
}

function factVisible(
  fact: FactEffect,
  canReadPath: CanReadVaultPath,
): boolean {
  return (
    nodeVisible(fact.subject, canReadPath) &&
    nodeVisible(fact.object, canReadPath) &&
    sourceRefsVisible(fact.sourceRefs, canReadPath)
  );
}

function nodeVisible(
  node: FactEffect["object"] | NodeRef,
  canReadPath: CanReadVaultPath,
): boolean {
  return node.kind !== "page" || canReadPath(node.path);
}

function searchResultVisible(
  result: SearchDocumentResult,
  canReadPath: CanReadVaultPath,
): boolean {
  return (
    canReadPath(result.path) &&
    sourceRefsVisible(result.sourceRefs, canReadPath)
  );
}

function sourceRefsVisible(
  sourceRefs: ReadonlyArray<SourceRef>,
  canReadPath: CanReadVaultPath,
): boolean {
  return sourceRefs.every((ref) => canReadPath(ref.path));
}
