import { openVault } from "../../vault";
import { makeDispatcher } from "../../dispatcher";
import { ok, type Result, type ToolError } from "../../types";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface DoctorReport {
  exitCode: 0 | 1;
  violations: string[];
}

// Pluralized wiki subdirectory -> singular page type (per PAGE_TYPE_BY_DIRECTORY).
const WIKI_DIR_TO_PAGE_TYPE: Readonly<Record<string, string>> = {
  entities: "entity",
  concepts: "concept",
  sources: "source",
  syntheses: "synthesis",
};

function expectedPageTypeForDir(dirName: string): string {
  return WIKI_DIR_TO_PAGE_TYPE[dirName] ?? dirName.replace(/s$/, "");
}

export async function domeDoctor(
  vaultPath: string,
  opts: { rebuildIndex?: boolean } = {},
): Promise<Result<DoctorReport, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  const vault = res.value;

  const violations: string[] = [];

  // Wiki page frontmatter checks: type matches directory
  const wikiRoot = join(vault.path, "wiki");
  if (existsSync(wikiRoot)) {
    const subdirs = await readdir(wikiRoot, { withFileTypes: true });
    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) continue;
      const files = await readdir(join(wikiRoot, subdir.name), { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith(".md")) continue;
        const rel = `wiki/${subdir.name}/${f.name}`;
        const out = await vault.tools.readDocument({ path: rel });
        if (!out.result.ok) continue;
        const doc = out.result.value;
        const expectedType = expectedPageTypeForDir(subdir.name);
        if (doc.frontmatter.type && doc.frontmatter.type !== expectedType) {
          violations.push(`${rel}: frontmatter type=${doc.frontmatter.type} does not match directory ${subdir.name}`);
        }
      }
    }
  }

  // rebuild-index
  if (opts.rebuildIndex) {
    const dispatcher = makeDispatcher(vault.path);
    if (existsSync(wikiRoot)) {
      const subdirs = await readdir(wikiRoot, { withFileTypes: true });
      for (const subdir of subdirs) {
        if (!subdir.isDirectory()) continue;
        const files = await readdir(join(wikiRoot, subdir.name), { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith(".md")) continue;
          const rel = `wiki/${subdir.name}/${f.name}`;
          const title = f.name.replace(/\.md$/, "");
          await dispatcher.writeIndex({ path: rel, title });
        }
      }
    }
  }

  return ok({ exitCode: violations.length === 0 ? 0 : 1, violations });
}
