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
const MAX_RELATED_ROWS = 8;
const TASK_METADATA_MARKER =
  /(?:^|\s)(?:\u{1F4C5}\s*\d{4}-\d{2}-\d{2}|\u{1F53A}|\u{23EB}|\u{1F53C}|\u{1F53D}|\u{23EC})(?=\s|$)/gu;
const TASK_DUE_MARKER =
  /(?:^|\s)\u{1F4C5}\s*(\d{4}-\d{2}-\d{2})(?=\s|$)/u;

const exportContext: Processor = defineProcessor({
  id: "dome.search.export-context",
  version: "0.1.4",
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
    const searchMatches = projection.searchDocuments({
      query: input.topic,
      limit: input.limit + 1,
    });
    const matches = Object.freeze(searchMatches.slice(0, input.limit));
    const hasMoreEntries = searchMatches.length > matches.length;
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
    const overview = buildOverview(input.topic, entries);
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
      shown: Object.freeze({
        entries: entries.length,
      }),
      hasMore: Object.freeze({
        entries: hasMoreEntries,
      }),
      overview,
      markdown: renderMarkdown(input.topic, overview, entries, hasMoreEntries),
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

type ContextOverview = {
  readonly readFirst: ReadonlyArray<ContextReadFirst>;
  readonly openLoops: ReadonlyArray<ContextOpenLoop>;
  readonly unresolvedQuestions: ReadonlyArray<ContextQuestionSummary>;
  readonly diagnostics: ReadonlyArray<ContextDiagnosticSummary>;
};

type ContextReadFirst = {
  readonly path: string;
  readonly title: string;
  readonly reason: string;
  readonly rank: number;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextFact = {
  readonly predicate: string;
  readonly object: string;
  readonly assertion: FactEffect["assertion"];
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextOpenLoop = {
  readonly path: string;
  readonly predicate: string;
  readonly text: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextDiagnostic = {
  readonly severity: DiagnosticEffect["severity"];
  readonly code: string;
  readonly message: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextDiagnosticSummary = ContextDiagnostic & {
  readonly path: string;
};

type ContextQuestion = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly resolveCommand: string;
  readonly processorId: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextQuestionSummary = ContextQuestion & {
  readonly path: string;
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
            object: factObjectLabel(fact),
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

function buildOverview(
  topic: string,
  entries: ReadonlyArray<ContextEntry>,
): ContextOverview {
  return Object.freeze({
    readFirst: Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          path: entry.path,
          title: entry.title,
          reason: readFirstReason(topic, entry),
          rank: entry.rank,
          sourceRefs: entry.sourceRefs,
        })
      ),
    ),
    openLoops: Object.freeze(
      uniqueOpenLoops(entries).slice(0, MAX_RELATED_ROWS),
    ),
    unresolvedQuestions: Object.freeze(
      uniqueQuestions(entries).slice(0, MAX_RELATED_ROWS),
    ),
    diagnostics: Object.freeze(
      uniqueDiagnostics(entries).slice(0, MAX_RELATED_ROWS),
    ),
  });
}

function readFirstReason(topic: string, entry: ContextEntry): string {
  const openLoops = entry.facts.filter(isOpenLoopFact).length;
  const parts = [
    `matches "${topic}"`,
    entry.type === null ? null : `${entry.type} page`,
    entry.questions.length === 0 ? null : `${entry.questions.length} question(s)`,
    openLoops === 0 ? null : `${openLoops} open loop(s)`,
    entry.diagnostics.length === 0
      ? null
      : `${entry.diagnostics.length} diagnostic(s)`,
  ].filter((part): part is string => part !== null);
  return parts.join("; ");
}

function uniqueOpenLoops(
  entries: ReadonlyArray<ContextEntry>,
): ReadonlyArray<ContextOpenLoop> {
  const seen = new Set<string>();
  const out: ContextOpenLoop[] = [];
  for (const entry of entries) {
    for (const fact of entry.facts) {
      if (!isOpenLoopFact(fact)) continue;
      const key = `${entry.path}\u0000${fact.predicate}\u0000${fact.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Object.freeze({
        path: entry.path,
        predicate: fact.predicate,
        text: fact.object,
        sourceRefs: fact.sourceRefs,
      }));
    }
  }
  return Object.freeze(out);
}

function uniqueQuestions(
  entries: ReadonlyArray<ContextEntry>,
): ReadonlyArray<ContextQuestionSummary> {
  const seen = new Set<number>();
  const out: ContextQuestionSummary[] = [];
  for (const entry of entries) {
    for (const question of entry.questions) {
      if (seen.has(question.id)) continue;
      seen.add(question.id);
      out.push(Object.freeze({
        ...question,
        path: entry.path,
      }));
    }
  }
  return Object.freeze(out);
}

function uniqueDiagnostics(
  entries: ReadonlyArray<ContextEntry>,
): ReadonlyArray<ContextDiagnosticSummary> {
  const seen = new Set<string>();
  const out: ContextDiagnosticSummary[] = [];
  for (const entry of entries) {
    for (const diagnostic of entry.diagnostics) {
      const key = [
        entry.path,
        diagnostic.severity,
        diagnostic.code,
        diagnostic.message,
      ].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Object.freeze({
        ...diagnostic,
        path: entry.path,
      }));
    }
  }
  return Object.freeze(out);
}

function isOpenLoopFact(fact: ContextFact): boolean {
  return (
    fact.predicate === "dome.daily.open_task" ||
    fact.predicate === "dome.daily.followup"
  );
}

function renderMarkdown(
  topic: string,
  overview: ContextOverview,
  entries: ReadonlyArray<ContextEntry>,
  hasMoreEntries: boolean,
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

  renderOverview(lines, overview);

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
      const facts = entry.facts.slice(0, MAX_RELATED_ROWS);
      for (const fact of facts) {
        const refs = fact.sourceRefs.map(formatSourceRef).join(", ");
        lines.push(`- \`${fact.predicate}\`: ${fact.object} (${refs})`);
      }
      appendMoreLine(lines, entry.facts.length, facts.length, "facts");
    }
    if (entry.diagnostics.length > 0) {
      lines.push("");
      lines.push("Diagnostics:");
      const diagnostics = entry.diagnostics.slice(0, MAX_RELATED_ROWS);
      for (const diagnostic of diagnostics) {
        const refs = diagnostic.sourceRefs.map(formatSourceRef).join(", ");
        lines.push(
          `- \`${diagnostic.severity}\` \`${diagnostic.code}\`: ${diagnostic.message} (${refs})`,
        );
      }
      appendMoreLine(
        lines,
        entry.diagnostics.length,
        diagnostics.length,
        "diagnostics",
      );
    }
    if (entry.questions.length > 0) {
      lines.push("");
      lines.push("Questions:");
      const questions = entry.questions.slice(0, MAX_RELATED_ROWS);
      for (const question of questions) {
        const refs = question.sourceRefs.map(formatSourceRef).join(", ");
        lines.push(`- [#${question.id}] ${question.question} (${refs})`);
        lines.push(`  resolve: ${question.resolveCommand}`);
      }
      appendMoreLine(
        lines,
        entry.questions.length,
        questions.length,
        "questions",
      );
    }
  }

  if (hasMoreEntries) {
    lines.push("");
    lines.push(
      "- ... more adopted-state matches exist (increase --limit to include more entries)",
    );
  }

  return lines.join("\n");
}

function renderOverview(lines: string[], overview: ContextOverview): void {
  if (overview.readFirst.length > 0) {
    lines.push("## Read First");
    for (const [index, item] of overview.readFirst.entries()) {
      lines.push(
        `${index + 1}. \`${item.path}\` - ${item.title} (${item.reason})`,
      );
    }
    lines.push("");
  }

  if (overview.openLoops.length > 0) {
    lines.push("## Open Loops");
    for (const item of overview.openLoops) {
      const refs = item.sourceRefs.map(formatSourceRef).join(", ");
      lines.push(
        `- \`${item.path}\` \`${item.predicate}\`: ${item.text} (${refs})`,
      );
    }
    lines.push("");
  }

  if (overview.unresolvedQuestions.length > 0) {
    lines.push("## Unresolved Questions");
    for (const question of overview.unresolvedQuestions) {
      const refs = question.sourceRefs.map(formatSourceRef).join(", ");
      lines.push(
        `- [#${question.id}] \`${question.path}\`: ${question.question} (${refs})`,
      );
      lines.push(`  resolve: ${question.resolveCommand}`);
    }
    lines.push("");
  }

  if (overview.diagnostics.length > 0) {
    lines.push("## Active Diagnostics");
    for (const diagnostic of overview.diagnostics) {
      const refs = diagnostic.sourceRefs.map(formatSourceRef).join(", ");
      lines.push(
        `- \`${diagnostic.path}\` \`${diagnostic.severity}\` \`${diagnostic.code}\`: ${diagnostic.message} (${refs})`,
      );
    }
    lines.push("");
  }
}

function appendMoreLine(
  lines: string[],
  total: number,
  shown: number,
  label: string,
): void {
  const remaining = total - shown;
  if (remaining <= 0) return;
  lines.push(`- ... ${remaining} more ${label}`);
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

function factObjectLabel(fact: FactEffect): string {
  const raw = objectLabel(fact.object);
  if (
    fact.object.kind !== "string" ||
    !(
      fact.predicate === "dome.daily.open_task" ||
      fact.predicate === "dome.daily.followup"
    )
  ) {
    return raw;
  }
  return dailyActionLabel(raw);
}

function dailyActionLabel(text: string): string {
  const stripped = stripDailyTaskMetadata(text);
  const dueDate = taskDueDate(text);
  const priority = taskPriority(text);
  const metadata = [
    dueDate === null ? null : `due: ${dueDate}`,
    priority === null ? null : `priority: ${priority}`,
  ].filter((item): item is string => item !== null);
  return metadata.length === 0 ? stripped : `${stripped} [${metadata.join(", ")}]`;
}

function stripDailyTaskMetadata(text: string): string {
  const stripped = text
    .replace(TASK_METADATA_MARKER, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : text;
}

function taskDueDate(text: string): string | null {
  return TASK_DUE_MARKER.exec(text)?.[1] ?? null;
}

function taskPriority(text: string): string | null {
  if (text.includes("\u{1F53A}")) return "highest";
  if (text.includes("\u{23EB}")) return "high";
  if (text.includes("\u{1F53C}")) return "medium";
  if (text.includes("\u{1F53D}")) return "low";
  if (text.includes("\u{23EC}")) return "lowest";
  return null;
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
