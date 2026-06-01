// dome.search.index-text — adopted markdown FTS projection.
//
// This processor emits SearchDocumentEffect values only. The engine-owned
// projection sink performs the SQLite FTS write after search.write capability
// enforcement, so the bundle stays pure and rebuildable.

import { basename } from "node:path/posix";

import matter from "gray-matter";

import {
  searchDocumentEffect,
  type Effect,
  type SearchDocumentEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

const searchIndexText: Processor = defineProcessor({
  id: "dome.search.index-text",
  version: "0.1.1",
  phase: "adoption",
  triggers: [
    { kind: "signal", name: "document.changed" },
    { kind: "signal", name: "file.created" },
    { kind: "signal", name: "file.deleted" },
  ],
  capabilities: [
    { kind: "read", paths: ["**/*.md"] },
    { kind: "search.write", paths: ["**/*.md"] },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: SearchDocumentEffect[] = [];
    const seen = new Set<string>();

    for (const path of ctx.changedPaths) {
      if (!path.endsWith(".md") || seen.has(path)) continue;
      seen.add(path);

      const sourceRefs = [ctx.sourceRef(path)];
      const content = await ctx.snapshot.readFile(path);
      if (content === null) {
        effects.push(
          searchDocumentEffect({
            operation: "delete",
            path,
            sourceRefs,
          }),
        );
        continue;
      }

      const doc = parseMarkdownDocument(path, content);
      effects.push(
        searchDocumentEffect({
          operation: "upsert",
          path,
          category: doc.category,
          ...(doc.type !== null ? { type: doc.type } : {}),
          title: doc.title,
          body: doc.body,
          sourceRefs,
        }),
      );
    }

    return effects;
  },
});

export default searchIndexText;

type ParsedMarkdownDocument = {
  readonly category: string;
  readonly type: string | null;
  readonly title: string;
  readonly body: string;
};

function parseMarkdownDocument(
  path: string,
  content: string,
): ParsedMarkdownDocument {
  let parsed: { readonly data: Record<string, unknown>; readonly content: string };
  try {
    parsed = matter(content);
  } catch {
    parsed = { data: {}, content };
  }

  return Object.freeze({
    category: categoryForPath(path),
    type: frontmatterString(parsed.data["type"]),
    title: titleFor(path, parsed),
    body: stripGeneratedSurfaceBlocks(parsed.content),
  });
}

function stripGeneratedSurfaceBlocks(content: string): string {
  return content
    .replace(
      /<!-- dome\.daily:open-loops:start -->[\s\S]*?<!-- dome\.daily:open-loops:end -->/g,
      "",
    )
    .replace(
      /<!-- dome\.daily:carried-forward:start -->[\s\S]*?<!-- dome\.daily:carried-forward:end -->/g,
      "",
    );
}

function categoryForPath(path: string): string {
  const first = path.split("/")[0] ?? "";
  switch (first) {
    case "wiki":
    case "notes":
    case "inbox":
    case "raw":
      return first;
    default:
      return "other";
  }
}

function titleFor(
  path: string,
  parsed: { readonly data: Record<string, unknown>; readonly content: string },
): string {
  const explicit = frontmatterString(parsed.data["title"]);
  if (explicit !== null) return explicit;

  const heading = /^#\s+(.+)$/m.exec(parsed.content)?.[1]?.trim();
  if (heading !== undefined && heading.length > 0) return heading;

  const base = basename(path, ".md").replace(/[-_]+/g, " ").trim();
  return base.length > 0 ? base : path;
}

function frontmatterString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
