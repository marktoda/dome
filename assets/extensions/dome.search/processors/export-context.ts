// dome.search.export-context — portable, source-backed context packets.

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
import type { SourceRef } from "../../../../src/core/source-ref";
import {
  groupByMatchingPath,
  questionItemFromProjection,
  uniqueSourceRefs,
  type SearchQuestionItem,
} from "./related";

const SCHEMA = "dome.search.export-context/v1";
const DEFAULT_LIMIT = 8;

const exportContext: Processor = defineProcessor({
  id: "dome.search.export-context",
  version: "0.1.1",
  phase: "view",
  triggers: [{ kind: "command", name: "export-context" }],
  capabilities: [{ kind: "read", paths: ["**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.projection === undefined) {
      throw new Error(
        "dome.search.export-context: ctx.projection is undefined; view-phase processors require a ProjectionQueryView",
      );
    }

    const projection = ctx.projection;
    const input = parseInput(ctx.input);
    const matches = projection.searchDocuments({
      query: input.topic,
      limit: input.limit,
    });
    const matchPaths = new Set(matches.map((match) => match.path));
    const diagnosticsByPath = groupByMatchingPath(
      projection.diagnostics(),
      matchPaths,
    );
    const questionsByPath = groupByMatchingPath(
      projection
        .questions({ resolved: false })
        .map(questionItemFromProjection),
      matchPaths,
    );
    const entries = matches.map((match) =>
      contextEntryFromMatch(
        match,
        projection.facts({
          subjectKind: "page",
          subjectId: match.path,
        }),
        diagnosticsByPath.get(match.path) ?? Object.freeze([]),
        questionsByPath.get(match.path) ?? Object.freeze([]),
      ),
    );
    const scope = uniqueSourceRefs(
      entries.flatMap((entry) => [
        ...entry.sourceRefs,
        ...entry.facts.flatMap((fact) => fact.sourceRefs),
        ...entry.diagnostics.flatMap((diagnostic) => diagnostic.sourceRefs),
        ...entry.questions.flatMap((question) => question.sourceRefs),
      ]),
    );
    const data = Object.freeze({
      schema: SCHEMA,
      topic: input.topic,
      limit: input.limit,
      markdown: renderMarkdown(input.topic, entries),
      entries: Object.freeze(entries),
    });

    const effect: ViewEffect = viewEffect({
      name: "dome.search.export-context",
      content: {
        kind: "structured",
        schema: SCHEMA,
        data,
      },
      scope,
    });
    return [effect];
  },
});

export default exportContext;

type ExportInput = {
  readonly topic: string;
  readonly limit: number;
};

type ContextEntry = {
  readonly path: string;
  readonly title: string;
  readonly category: string;
  readonly type: string | null;
  readonly snippet: string;
  readonly rank: number;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly facts: ReadonlyArray<ContextFact>;
  readonly diagnostics: ReadonlyArray<ContextDiagnostic>;
  readonly questions: ReadonlyArray<ContextQuestion>;
};

type ContextFact = {
  readonly predicate: string;
  readonly object: string;
  readonly assertion: FactEffect["assertion"];
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextDiagnostic = {
  readonly severity: DiagnosticEffect["severity"];
  readonly code: string;
  readonly message: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextQuestion = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly resolveCommand: string;
  readonly processorId: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

function contextEntryFromMatch(
  match: SearchDocumentResult,
  facts: ReadonlyArray<FactEffect>,
  diagnostics: ReadonlyArray<DiagnosticEffect>,
  questions: ReadonlyArray<SearchQuestionItem>,
): ContextEntry {
  return Object.freeze({
    path: match.path,
    title: match.title,
    category: match.category,
    type: match.type,
    snippet: stripFtsMarkers(match.snippet),
    rank: match.rank,
    sourceRefs: Object.freeze([...match.sourceRefs]),
    facts: Object.freeze(
      facts
        .map((fact) =>
          Object.freeze({
            predicate: fact.predicate,
            object: objectLabel(fact.object),
            assertion: fact.assertion,
            sourceRefs: Object.freeze([...fact.sourceRefs]),
          })
        )
        .sort(compareFacts),
    ),
    diagnostics: Object.freeze(
      diagnostics
        .map((diagnostic) =>
          Object.freeze({
            severity: diagnostic.severity,
            code: diagnostic.code,
            message: diagnostic.message,
            sourceRefs: Object.freeze([...diagnostic.sourceRefs]),
          })
        )
        .sort(compareDiagnostics),
    ),
    questions: Object.freeze(
      questions
        .map((question) =>
          Object.freeze({
            id: question.id,
            question: question.question,
            options: question.options,
            resolveCommand: question.resolveCommand,
            processorId: question.processorId,
            sourceRefs: Object.freeze([...question.sourceRefs]),
          })
        )
        .sort(compareQuestions),
    ),
  });
}

function renderMarkdown(
  topic: string,
  entries: ReadonlyArray<ContextEntry>,
): string {
  const lines = [
    `# Dome Context: ${topic}`,
    "",
    `Schema: \`${SCHEMA}\``,
    "",
  ];

  if (entries.length === 0) {
    lines.push("No adopted-state matches.");
    return lines.join("\n");
  }

  lines.push("## Matches");
  for (const [index, entry] of entries.entries()) {
    lines.push("");
    lines.push(`### ${index + 1}. ${entry.title}`);
    lines.push(`- Path: \`${entry.path}\``);
    lines.push(`- Category: \`${entry.category}\``);
    if (entry.type !== null) lines.push(`- Type: \`${entry.type}\``);
    lines.push("- SourceRefs:");
    for (const ref of entry.sourceRefs) {
      lines.push(`  - \`${formatSourceRef(ref)}\``);
    }
    if (entry.snippet.length > 0) {
      lines.push("");
      lines.push("> " + entry.snippet.replace(/\n/g, "\n> "));
    }
    if (entry.facts.length > 0) {
      lines.push("");
      lines.push("Facts:");
      for (const fact of entry.facts.slice(0, 8)) {
        const refs = fact.sourceRefs.map(formatSourceRef).join(", ");
        lines.push(`- \`${fact.predicate}\`: ${fact.object} (${refs})`);
      }
    }
    if (entry.diagnostics.length > 0) {
      lines.push("");
      lines.push("Diagnostics:");
      for (const diagnostic of entry.diagnostics.slice(0, 8)) {
        const refs = diagnostic.sourceRefs.map(formatSourceRef).join(", ");
        lines.push(
          `- \`${diagnostic.severity}\` \`${diagnostic.code}\`: ${diagnostic.message} (${refs})`,
        );
      }
    }
    if (entry.questions.length > 0) {
      lines.push("");
      lines.push("Questions:");
      for (const question of entry.questions.slice(0, 8)) {
        const refs = question.sourceRefs.map(formatSourceRef).join(", ");
        lines.push(`- [#${question.id}] ${question.question} (${refs})`);
        lines.push(`  resolve: ${question.resolveCommand}`);
      }
    }
  }

  return lines.join("\n");
}

function parseInput(input: unknown): ExportInput {
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
  const topic = stringValue(record.topic) ?? stringValue(flags.topic) ?? "";
  const limit = clampLimit(numberValue(record.limit) ?? numberValue(flags.limit));
  return Object.freeze({ topic, limit });
}

function compareFacts(a: ContextFact, b: ContextFact): number {
  const predicate = a.predicate.localeCompare(b.predicate);
  return predicate !== 0 ? predicate : a.object.localeCompare(b.object);
}

function compareDiagnostics(
  a: ContextDiagnostic,
  b: ContextDiagnostic,
): number {
  const severity = a.severity.localeCompare(b.severity);
  if (severity !== 0) return severity;
  const code = a.code.localeCompare(b.code);
  return code !== 0 ? code : a.message.localeCompare(b.message);
}

function compareQuestions(
  a: ContextQuestion,
  b: ContextQuestion,
): number {
  return a.id - b.id;
}

function objectLabel(value: FactEffect["object"]): string {
  if (value.kind === "string") return value.value;
  if (value.kind === "number") return String(value.value);
  if (value.kind === "date") return value.value;
  if (value.kind === "page") return value.path;
  if (value.kind === "task") return value.stableId;
  return value.name;
}

function formatSourceRef(ref: SourceRef): string {
  const suffix = ref.range === undefined
    ? ""
    : `:${ref.range.startLine}-${ref.range.endLine}`;
  return `${ref.path}${suffix} @ ${ref.commit.slice(0, 7)}`;
}

function stripFtsMarkers(snippet: string): string {
  return snippet.replace(/\[/g, "").replace(/\]/g, "");
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

function clampLimit(raw: number | null): number {
  if (raw === null || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(25, Math.trunc(raw)));
}
