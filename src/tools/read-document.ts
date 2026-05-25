import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeDocument, type Document } from "../document";
import { parseFrontmatter } from "../frontmatter";
import { parseWikilinks } from "../wikilinks";
import { ok, err, type ToolReturn } from "../types";
import type { Vault } from "../vault";

export interface ReadDocumentInput {
  path: string;
}

export async function readDocument(
  vault: Vault,
  input: ReadDocumentInput
): Promise<ToolReturn<Document>> {
  const abs = join(vault.path, input.path);
  let text: string;
  try {
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
  });
  return { result: ok(doc), effects: [] };
}
