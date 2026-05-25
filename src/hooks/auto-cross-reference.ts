import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { HookHandler } from "../hook-context";

export const autoCrossReference: HookHandler = async (event, ctx) => {
  const path = event.path;
  if (typeof path !== "string") return;
  const entityName = basename(path).replace(/\.md$/, "");
  const newLink = `[[wiki/entities/${entityName}]]`;

  // Scan all wiki pages other than this one and add backlinks where the entity name appears as a word.
  const wikiRoot = join(ctx.vault.path, "wiki");
  const wordRegex = new RegExp(`(?<![\\w\\[/-])${escapeRegex(entityName)}(?![\\w\\]-])`, "g");

  for await (const filePath of walk(wikiRoot)) {
    if (filePath === join(ctx.vault.path, path)) continue;
    const rel = relative(ctx.vault.path, filePath);
    const text = await readFile(filePath, "utf8");
    if (text.includes(newLink)) continue; // already linked
    if (!wordRegex.test(text)) continue;
    wordRegex.lastIndex = 0;
    const updated = text.replace(wordRegex, newLink);
    if (updated === text) continue;
    // Use the Tool to write so invariants are enforced. Re-write the page with the updated body.
    const parsed = await readDocViaTool(ctx, rel);
    if (!parsed) continue;
    await ctx.tools.writeDocument({
      path: rel,
      body: stripFrontmatter(updated),
      frontmatter: parsed.frontmatter,
      opts: { create: false },
    });
  }
};

async function readDocViaTool(
  ctx: Parameters<HookHandler>[1],
  path: string
): Promise<{ frontmatter: Record<string, unknown>; body: string } | null> {
  const out = await ctx.tools.readDocument({ path });
  if (!out.result.ok) return null;
  return { frontmatter: out.result.value.frontmatter, body: out.result.value.body };
}

function stripFrontmatter(text: string): string {
  // Pull body out of a markdown text by removing leading frontmatter if present.
  const m = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return m ? m[1]! : text;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
