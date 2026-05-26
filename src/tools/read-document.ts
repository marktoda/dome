import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeDocument, type Document } from "../document";
import { parseFrontmatter } from "../frontmatter";
import { parseWikilinks } from "../wikilinks";
import { ok, err, type ToolReturn } from "../types";
import type { Vault } from "../vault";

export interface ReadDocumentInput {
  path: string;
}

/**
 * Read a Document from disk. Returns the parsed frontmatter + body + wikilinks
 * + an `mtime` snapshot the caller can thread into a subsequent mutating Tool
 * as `expected_mtime` for optimistic locking (see docs/wiki/gotchas/
 * concurrent-harness-write.md).
 */
export async function readDocument(
  vault: Vault,
  input: ReadDocumentInput
): Promise<ToolReturn<Document>> {
  const abs = join(vault.path, input.path);
  let text: string;
  let mtime: string | null = null;
  try {
    // stat first so the mtime corresponds to the bytes we then read.
    const st = await stat(abs);
    mtime = st.mtime.toISOString();
    text = await readFile(abs, "utf8");
  } catch (e: unknown) {
    const errno = (e as { code?: string }).code;
    if (errno === "ENOENT") {
      return { result: err({ kind: "not-found", path: input.path }), effects: [] };
    }
    return { result: err({ kind: "validation", message: (e as Error).message }), effects: [] };
  }
  const parsed = parseFrontmatter(text);
  const linksOut = parseWikilinks(parsed.body);
  const doc = makeDocument({
    path: input.path,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    linksOut,
    mtime,
  });
  return { result: ok(doc), effects: [] };
}
