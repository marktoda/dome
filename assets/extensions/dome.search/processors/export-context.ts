// dome.search.export-context — portable, source-backed context packets.

import {
  viewEffect,
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

const SCHEMA = "dome.search.export-context/v1";
const DEFAULT_LIMIT = 8;

const exportContext: Processor = defineProcessor({
  id: "dome.search.export-context",
  version: "0.1.0",
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
    const entries = matches.map((match) =>
      contextEntryFromMatch(
        match,
        projection.facts({
          subjectKind: "page",
          subjectId: match.path,
        }),
      ),
    );
    const scope = uniqueSourceRefs(
      entries.flatMap((entry) => [
        ...entry.sourceRefs,
        ...entry.facts.flatMap((fact) => fact.sourceRefs),
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
};

type ContextFact = {
  readonly predicate: string;
  readonly object: string;
  readonly assertion: FactEffect["assertion"];
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

function contextEntryFromMatch(
  match: SearchDocumentResult,
  facts: ReadonlyArray<FactEffect>,
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

function uniqueSourceRefs(
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
