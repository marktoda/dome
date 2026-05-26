import { writeFile, readFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeDocument, type Document } from "../document";
import { stringifyFrontmatter } from "../frontmatter";
import { ok, err, type Effect, type ToolReturn, type Sensitivity, type CreationReason } from "../types";
import type { Vault } from "../vault";
import { type Dispatcher, refuseIfDispatcherOwned } from "../dispatcher";
import { parseWikilinks, suggestFullPath } from "../wikilinks";
import { singularOf } from "../page-type";
import { refuseIfRawImmutable, checkOptimisticLock, logMutation } from "./guards";

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
  /**
   * Optimistic-locking snapshot from a prior readDocument call. When set, the
   * Tool re-reads the file's mtime immediately before writing and returns
   * concurrent-write-conflict if it has changed. Omit for "last write wins"
   * semantics — the v0.5 default for single-user, single-session workflows.
   * See docs/wiki/specs/sdk-surface.md §Concurrency.
   */
  expected_mtime?: string;
}

export async function writeDocument(
  vault: Vault,
  dispatcher: Dispatcher,
  input: WriteDocumentInput
): Promise<ToolReturn<Document>> {
  // INDEX_AND_LOG_ARE_DISPATCHER_OWNED — axiom; refuse unconditionally.
  const ownedErr = refuseIfDispatcherOwned(input.path, "writeDocument");
  if (ownedErr) return { result: err(ownedErr), effects: [] };

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
  const rawErr = refuseIfRawImmutable(input.path, "writeDocument", `attempted: ${input.path}`);
  if (rawErr) return { result: err(rawErr), effects: [] };

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
    const singular = singularOf(dirType);
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

  // SENSITIVE_GOES_TO_INBOX — opt-in; when enabled, sensitive content can't land in wiki/.
  if (
    vault.config.invariants.SENSITIVE_GOES_TO_INBOX === "enabled" &&
    input.opts?.sensitivity_classified === "sensitive" &&
    doc0.category === "wiki"
  ) {
    return {
      result: err({ kind: "sensitive-must-route-to-inbox", path: input.path }),
      effects: [],
    };
  }

  // PAGE_CREATION_REQUIRES_RECURRENCE — opt-in; create requires a reason.
  if (
    vault.config.invariants.PAGE_CREATION_REQUIRES_RECURRENCE === "enabled" &&
    input.opts?.create === true &&
    !input.opts.reason
  ) {
    return {
      result: err({ kind: "page-creation-requires-reason", path: input.path }),
      effects: [],
    };
  }

  await mkdir(dirname(abs), { recursive: true });

  // Optimistic-locking re-check (only fires when the caller threaded
  // expected_mtime from a prior readDocument).
  if (exists) {
    const lockErr = await checkOptimisticLock(abs, input.path, input.expected_mtime);
    if (lockErr) return { result: err(lockErr), effects: [] };
  }

  const before = exists ? await readFile(abs, "utf8") : "";
  const text = stringifyFrontmatter(input.frontmatter, input.body);
  await writeFile(abs, text);

  const effects: Effect[] = [
    { kind: "wrote-document", path: input.path, diff: makeDiff(before, text, input.path) },
  ];

  const logEffect = await logMutation(vault, dispatcher, {
    verb: exists ? "update" : "ingest",
    subject: input.path,
  });
  if (logEffect) effects.push(logEffect);

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

