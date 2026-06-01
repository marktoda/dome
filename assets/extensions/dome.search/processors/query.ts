// dome.search.query — view-phase adopted-state query.
//
// The processor reads the projection query view, not SQLite. It returns one
// structured ViewEffect so CLI/MCP/future surfaces can render the same data.

import {
  viewEffect,
  type DiagnosticEffect,
  type Effect,
  type FactEffect,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
  type SearchDocumentResult,
} from "../../../../src/core/processor";
import {
  groupByMatchingPath,
  questionItemFromProjection,
  uniqueSourceRefs,
  type SearchQuestionItem,
} from "./related";

const searchQuery: Processor = defineProcessor({
  id: "dome.search.query",
  version: "0.1.1",
  phase: "view",
  triggers: [{ kind: "command", name: "query" }],
  capabilities: [{ kind: "read", paths: ["**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.projection === undefined) {
      throw new Error(
        "dome.search.query: ctx.projection is undefined; view-phase processors require a ProjectionQueryView",
      );
    }

    const input = parseQueryInput(ctx.input);
    const matches = ctx.projection.searchDocuments({
      query: input.text,
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    const factsByPath = factsForMatches(ctx, matches);
    const diagnosticsByPath = diagnosticsForMatches(ctx, matches);
    const questionsByPath = questionsForMatches(ctx, matches);
    const data = Object.freeze({
      schema: "dome.search.query/v1",
      query: input.text,
      filters: Object.freeze({
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
      }),
      matches: Object.freeze(
        matches.map((match) =>
          Object.freeze({
            path: match.path,
            title: match.title,
            category: match.category,
            type: match.type,
            snippet: match.snippet,
            rank: match.rank,
            sourceRefs: match.sourceRefs,
            facts: factsByPath.get(match.path) ?? Object.freeze([]),
            diagnostics: diagnosticsByPath.get(match.path) ?? Object.freeze([]),
            questions: questionsByPath.get(match.path) ?? Object.freeze([]),
          }),
        ),
      ),
    });

    const effect: ViewEffect = viewEffect({
      name: "dome.search.query",
      content: {
        kind: "structured",
        schema: "dome.search.query/v1",
        data,
      },
      scope: uniqueSourceRefs([
        ...matches.flatMap((match) => [...match.sourceRefs]),
        ...[...factsByPath.values()].flatMap((facts) =>
          facts.flatMap((fact) => [...fact.sourceRefs])
        ),
        ...[...diagnosticsByPath.values()].flatMap((diagnostics) =>
          diagnostics.flatMap((diagnostic) => [...diagnostic.sourceRefs])
        ),
        ...[...questionsByPath.values()].flatMap((questions) =>
          questions.flatMap((question) => [...question.sourceRefs])
        ),
      ]),
    });
    return [effect];
  },
});

export default searchQuery;

type QueryInput = {
  readonly text: string;
  readonly category?: string;
  readonly type?: string;
  readonly limit?: number;
};

function parseQueryInput(input: unknown): QueryInput {
  const envelope = input !== null && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  const record = envelope.commandArgs !== null &&
    typeof envelope.commandArgs === "object"
    ? envelope.commandArgs as Record<string, unknown>
    : envelope;
  const flags = record.flags !== null && typeof record.flags === "object"
    ? record.flags as Record<string, unknown>
    : {};

  const text = stringValue(record.text) ?? stringValue(flags.q) ?? "";
  const category = stringValue(record.category) ?? stringValue(flags.category);
  const type = stringValue(record.type) ?? stringValue(flags.type);
  const limit = numberValue(record.limit) ?? numberValue(flags.limit);
  return Object.freeze({
    text,
    ...(category !== null ? { category } : {}),
    ...(type !== null ? { type } : {}),
    ...(limit !== null ? { limit } : {}),
  });
}

function factsForMatches(
  ctx: ProcessorContext,
  matches: ReadonlyArray<SearchDocumentResult>,
): ReadonlyMap<string, ReadonlyArray<FactEffect>> {
  if (ctx.projection === undefined) return Object.freeze(new Map());
  const out = new Map<string, ReadonlyArray<FactEffect>>();
  for (const match of matches) {
    out.set(
      match.path,
      ctx.projection.facts({
        subjectKind: "page",
        subjectId: match.path,
      }),
    );
  }
  return out;
}

function diagnosticsForMatches(
  ctx: ProcessorContext,
  matches: ReadonlyArray<SearchDocumentResult>,
): ReadonlyMap<string, ReadonlyArray<DiagnosticEffect>> {
  if (ctx.projection === undefined) return Object.freeze(new Map());
  const matchPaths = new Set(matches.map((match) => match.path));
  return groupByMatchingPath(
    ctx.projection.diagnostics(),
    matchPaths,
  );
}

function questionsForMatches(
  ctx: ProcessorContext,
  matches: ReadonlyArray<SearchDocumentResult>,
): ReadonlyMap<string, ReadonlyArray<SearchQuestionItem>> {
  if (ctx.projection === undefined) return Object.freeze(new Map());
  const matchPaths = new Set(matches.map((match) => match.path));
  return groupByMatchingPath(
    ctx.projection
      .questions({ resolved: false })
      .map(questionItemFromProjection),
    matchPaths,
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
