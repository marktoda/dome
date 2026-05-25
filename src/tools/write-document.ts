import { writeFile, readFile, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeDocument, type Document } from "../document";
import { stringifyFrontmatter } from "../frontmatter";
import { ok, err, type Effect, type ToolReturn, type Sensitivity, type CreationReason } from "../types";
import type { Vault } from "../vault";
import type { Dispatcher } from "../dispatcher";

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

  // (Invariant checks will be wired in subsequent tasks.)

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
