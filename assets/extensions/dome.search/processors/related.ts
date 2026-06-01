// Shared related-state helpers for dome.search view processors.

import type { ProjectionQuestion } from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

export type SearchQuestionItem = ProjectionQuestion & {
  readonly options: ReadonlyArray<string>;
  readonly resolveCommand: string;
};

export function questionItemFromProjection(
  question: ProjectionQuestion,
): SearchQuestionItem {
  const options = Object.freeze([...(question.options ?? [])]);
  return Object.freeze({
    ...question,
    options,
    resolveCommand: resolveCommandFor(question.id, options),
  });
}

export function groupByMatchingPath<
  T extends { readonly sourceRefs: ReadonlyArray<SourceRef> },
>(
  rows: ReadonlyArray<T>,
  matchPaths: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlyArray<T>> {
  const mutable = new Map<string, T[]>();
  for (const row of rows) {
    const paths = new Set(
      row.sourceRefs
        .map((ref) => ref.path)
        .filter((path) => matchPaths.has(path)),
    );
    for (const path of paths) {
      const group = mutable.get(path);
      if (group === undefined) {
        mutable.set(path, [row]);
      } else {
        group.push(row);
      }
    }
  }
  return Object.freeze(
    new Map([...mutable.entries()].map(([path, rows]) => [
      path,
      Object.freeze([...rows]),
    ])),
  );
}

export function uniqueSourceRefs(
  refs: ReadonlyArray<SourceRef>,
): ReadonlyArray<SourceRef> {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const ref of refs) {
    const key = [
      ref.commit,
      ref.path,
      ref.range?.startLine ?? "",
      ref.range?.endLine ?? "",
      ref.stableId ?? "",
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return Object.freeze(out);
}

function resolveCommandFor(
  id: number,
  options: ReadonlyArray<string>,
): string {
  const placeholder = options.length === 0
    ? "<answer>"
    : `<${options.join("|")}>`;
  return `dome resolve ${id} ${placeholder}`;
}
