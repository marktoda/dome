import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ok, type ToolReturn, type SearchMatch } from "../types";
import type { Vault } from "../vault";
import { walkMd } from "../vault-fs";

export interface SearchIndexInput {
  query: string;
  filters?: {
    category?: string;
    type?: string;
    tags?: string[];
  };
}

export async function searchIndex(
  vault: Vault,
  input: SearchIndexInput
): Promise<ToolReturn<ReadonlyArray<SearchMatch>>> {
  const matches: SearchMatch[] = [];
  const q = input.query.toLowerCase();

  for await (const filePath of walkMd(join(vault.path, "wiki"))) {
    const rel = relative(vault.path, filePath);

    if (input.filters?.type) {
      const segments = rel.split("/");
      if (segments[1] !== `${input.filters.type}s` && segments[1] !== input.filters.type) continue;
    }

    const text = await readFile(filePath, "utf8");
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) continue;
    const excerpt = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + 80));
    matches.push({ path: rel, excerpt, score: 1 });
  }
  return { result: ok(matches), effects: [] };
}
