import type { WikiLink } from "./types";

export type DocumentCategory =
  | "raw"
  | "wiki"
  | "log"
  | "index"
  | "notes"
  | "inbox"
  | "config"
  | "external";

export interface DocumentInput {
  path: string;                                  // relative to vault root
  frontmatter?: Record<string, unknown>;
  body?: string;
  linksOut?: ReadonlyArray<WikiLink>;
  /**
   * Filesystem mtime captured by readDocument (ISO 8601). null for synthesized
   * Documents from makeDocument({ path }) without a real file behind them.
   * Callers thread this into mutating Tools as `expected_mtime` to enable
   * optimistic locking (see docs/wiki/specs/sdk-surface.md §Concurrency).
   */
  mtime?: string | null;
}

export interface Document {
  readonly path: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
  readonly linksOut: ReadonlyArray<WikiLink>;
  readonly category: DocumentCategory;
  readonly type: string | null;
  readonly isImmutable: boolean;
  /**
   * Filesystem mtime as ISO-8601 string from readDocument; null for
   * synthesized Documents. Threaded into mutating Tools as `expected_mtime`
   * for optimistic locking.
   */
  readonly mtime: string | null;
}

const KNOWN_TOP_LEVEL: Record<string, DocumentCategory> = {
  raw: "raw",
  wiki: "wiki",
  notes: "notes",
  inbox: "inbox",
  ".dome": "config",
  ".git": "external",
};

const ROOT_FILE_CATEGORIES: Record<string, DocumentCategory> = {
  "log.md": "log",
  "index.md": "index",
};

function deriveCategory(path: string): DocumentCategory {
  if (path in ROOT_FILE_CATEGORIES) return ROOT_FILE_CATEGORIES[path]!;
  const slashIdx = path.indexOf("/");
  if (slashIdx === -1) {
    return "notes";
  }
  const top = path.slice(0, slashIdx);
  if (top in KNOWN_TOP_LEVEL) return KNOWN_TOP_LEVEL[top]!;
  return "external";
}

function deriveType(path: string, category: DocumentCategory): string | null {
  if (category !== "wiki") return null;
  // Returns the plural directory name (e.g., "entities", "concepts") — the
  // canonical truth per docs/wiki/specs/sdk-surface.md §"Document". Frontmatter
  // `type:` is the singular form ("entity", "concept"); the two are reconciled
  // via page-type.ts helpers (pluralOf / singularOf).
  const parts = path.split("/");
  if (parts.length < 3) return null;
  return parts[1] ?? null;
}

export function makeDocument(input: DocumentInput): Document {
  const path = input.path;
  const category = deriveCategory(path);
  const type = deriveType(path, category);
  return {
    path,
    frontmatter: input.frontmatter ?? {},
    body: input.body ?? "",
    linksOut: input.linksOut ?? [],
    category,
    type,
    isImmutable: category === "raw",
    mtime: input.mtime ?? null,
  };
}
