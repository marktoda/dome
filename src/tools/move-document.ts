import { readFile, writeFile, rename, mkdir, readdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeDocument, type Document } from "../document";
import { ok, err, type Effect, type ToolReturn } from "../types";
import type { Vault } from "../vault";
import { type Dispatcher, refuseIfDispatcherOwned } from "../dispatcher";

export interface MoveDocumentInput {
  from: string;
  to: string;
  reason: string;
}

export async function moveDocument(
  vault: Vault,
  dispatcher: Dispatcher,
  input: MoveDocumentInput
): Promise<ToolReturn<Document>> {
  const fromOwned = refuseIfDispatcherOwned(input.from, "moveDocument");
  if (fromOwned) return { result: err(fromOwned), effects: [] };
  const toOwned = refuseIfDispatcherOwned(input.to, "moveDocument");
  if (toOwned) return { result: err(toOwned), effects: [] };

  const fromDoc = makeDocument({ path: input.from });
  const toDoc = makeDocument({ path: input.to });

  if (fromDoc.category === "raw" || toDoc.category === "raw") {
    return {
      result: err({
        kind: "invariant-violated",
        invariant: "RAW_IS_IMMUTABLE",
        detail: `moveDocument refuses raw/ source or target; from=${input.from} to=${input.to}`,
      }),
      effects: [],
    };
  }

  if (vault.config.invariants.PAGE_TYPE_BY_DIRECTORY === "enabled" && toDoc.category === "wiki") {
    if (toDoc.type === null) {
      return {
        result: err({
          kind: "invariant-violated",
          invariant: "PAGE_TYPE_BY_DIRECTORY",
          detail: `wiki destination requires <type>/<filename>; to: ${input.to}`,
        }),
        effects: [],
      };
    }
  }

  const fromAbs = join(vault.path, input.from);
  const toAbs = join(vault.path, input.to);
  try {
    await access(fromAbs);
  } catch {
    return { result: err({ kind: "not-found", path: input.from }), effects: [] };
  }
  try {
    await access(toAbs);
    return { result: err({ kind: "already-exists", path: input.to }), effects: [] };
  } catch {
    // expected
  }

  await mkdir(dirname(toAbs), { recursive: true });
  await rename(fromAbs, toAbs);

  const oldTarget = input.from.replace(/\.md$/, "");
  const newTarget = input.to.replace(/\.md$/, "");
  await rewriteBacklinks(vault.path, oldTarget, newTarget);

  const effects: Effect[] = [
    { kind: "moved-document", from: input.from, to: input.to },
    { kind: "wrote-document", path: input.to, diff: `--- ${input.from}\n+++ ${input.to}\n[moved]` },
  ];

  if (vault.config.invariants.EVERY_WRITE_IS_LOGGED === "enabled") {
    const e = await dispatcher.appendLogEntry({
      ts: new Date().toISOString(),
      verb: "update",
      subject: `move ${input.from} -> ${input.to}`,
      body: input.reason,
    });
    effects.push(e);
  }

  const result = makeDocument({ path: input.to });
  return { result: ok(result), effects };
}

async function rewriteBacklinks(vaultPath: string, oldTarget: string, newTarget: string): Promise<void> {
  const oldLink = `[[${oldTarget}]]`;
  const newLink = `[[${newTarget}]]`;
  for await (const file of walkMd(vaultPath, ["wiki", "notes"])) {
    const text = await readFile(file, "utf8");
    if (text.includes(oldLink)) {
      await writeFile(file, text.split(oldLink).join(newLink));
    }
  }
}

async function* walkMd(root: string, allowedTops: ReadonlyArray<string>): AsyncGenerator<string> {
  for (const top of allowedTops) {
    yield* walk(join(root, top));
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && p.endsWith(".md")) yield p;
  }
}
