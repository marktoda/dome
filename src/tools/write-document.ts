import { writeFile, readFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeDocument, type Document } from "../document";
import { stringifyFrontmatter } from "../frontmatter";
import { ok, err, type Effect, type ToolReturn, type Sensitivity, type CreationReason } from "../types";
import type { Vault } from "../vault";
import type { Dispatcher } from "../dispatcher";
import { parseWikilinks, suggestFullPath } from "../wikilinks";

export interface WriteDocumentOpts {
  create?: boolean;
  reason?: CreationReason;
  sensitivity_classified?: Sensitivity;
}

export interface WriteDocumentInput {
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  opts?: WriteDocumentOpts;
}

export async function writeDocument(
  vault: Vault,
  dispatcher: Dispatcher,
  input: WriteDocumentInput
): Promise<ToolReturn<Document>> {
  // INDEX_AND_LOG_ARE_DISPATCHER_OWNED — axiom; refuse unconditionally.
  if (input.path === "index.md" || input.path === "log.md") {
    return {
      result: err({ kind: "dispatcher-owned-path", path: input.path, requested_tool: "writeDocument" }),
      effects: [],
    };
  }

  const abs = join(vault.path, input.path);
  const exists = await pathExists(abs);

  if (input.opts?.create && exists) {
    return { result: err({ kind: "already-exists", path: input.path }), effects: [] };
  }
  if (!input.opts?.create && !exists) {
    return { result: err({ kind: "not-found", path: input.path }), effects: [] };
  }

  // RAW_IS_IMMUTABLE — axiom; refuse raw/ targets unconditionally.
  const doc0 = makeDocument({ path: input.path });
  if (doc0.category === "raw") {
    return {
      result: err({
        kind: "invariant-violated",
        invariant: "RAW_IS_IMMUTABLE",
        detail: `writeDocument refuses raw/ targets; attempted: ${input.path}`,
      }),
      effects: [],
    };
  }

  // PAGE_TYPE_BY_DIRECTORY — when enabled, wiki/ writes must have directory match frontmatter type.
  if (vault.config.invariants.PAGE_TYPE_BY_DIRECTORY === "enabled" && doc0.category === "wiki") {
    const dirType = doc0.type;
    if (dirType === null) {
      return {
        result: err({
          kind: "invariant-violated",
          invariant: "PAGE_TYPE_BY_DIRECTORY",
          detail: `wiki/ writes require <type>/<filename>; path: ${input.path}`,
        }),
        effects: [],
      };
    }
    const singular = singularize(dirType);
    const allowed = [...vault.pageTypes.defaults, ...vault.pageTypes.extensions.map(e => typeof e === "string" ? e : e.name)];
    if (!allowed.includes(singular)) {
      return {
        result: err({
          kind: "invariant-violated",
          invariant: "PAGE_TYPE_BY_DIRECTORY",
          detail: `Unknown wiki page type: ${singular}. Declared types: ${allowed.join(", ")}`,
        }),
        effects: [],
      };
    }
    if (input.frontmatter.type !== singular) {
      return {
        result: err({
          kind: "invariant-violated",
          invariant: "PAGE_TYPE_BY_DIRECTORY",
          detail: `Frontmatter type ${input.frontmatter.type} does not match directory ${dirType}`,
        }),
        effects: [],
      };
    }
  }

  // WIKILINKS_ARE_FULLPATH — when enabled, body must use full-path wikilinks.
  if (vault.config.invariants.WIKILINKS_ARE_FULLPATH === "enabled") {
    const links = parseWikilinks(input.body);
    const short = links.find(l => !l.isFullPath);
    if (short) {
      return {
        result: err({
          kind: "wikilink-not-fullpath",
          link: short.raw,
          suggestion: `[[${suggestFullPath(short.target)}]]`,
        }),
        effects: [],
      };
    }
  }

  await mkdir(dirname(abs), { recursive: true });
  const before = exists ? await readFile(abs, "utf8") : "";
  const text = stringifyFrontmatter(input.frontmatter, input.body);
  await writeFile(abs, text);

  const effects: Effect[] = [
    { kind: "wrote-document", path: input.path, diff: makeDiff(before, text, input.path) },
  ];

  if (vault.config.invariants.EVERY_WRITE_IS_LOGGED === "enabled") {
    const verb = exists ? "update" : "ingest";
    const subject = input.path;
    const effect = await dispatcher.appendLogEntry({
      ts: new Date().toISOString(),
      verb,
      subject,
    });
    effects.push(effect);
  }

  const doc = makeDocument({ path: input.path, body: input.body, frontmatter: input.frontmatter });
  return { result: ok(doc), effects };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function makeDiff(before: string, after: string, path: string): string {
  if (!before) return `--- /dev/null\n+++ ${path}\n[new file]`;
  if (before === after) return `--- ${path}\n+++ ${path}\n[no change]`;
  return `--- a/${path}\n+++ b/${path}\n[content updated]`;
}

function singularize(plural: string): string {
  const explicit: Record<string, string> = {
    entities: "entity",
    concepts: "concept",
    sources: "source",
    syntheses: "synthesis",
  };
  return explicit[plural] ?? (plural.endsWith("ies") ? plural.slice(0, -3) + "y" : plural.endsWith("es") ? plural.slice(0, -2) : plural.endsWith("s") ? plural.slice(0, -1) : plural);
}
