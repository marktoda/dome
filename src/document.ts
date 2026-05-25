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
}

export interface Document {
  readonly path: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
  readonly linksOut: ReadonlyArray<WikiLink>;
  readonly category: DocumentCategory;
  readonly type: string | null;
  readonly isImmutable: boolean;
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
  };
}
