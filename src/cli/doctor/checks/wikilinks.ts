// Wikilink integrity check.
//
//   CHECK 2: short-form wikilinks violate WIKILINKS_ARE_FULLPATH.
//   CHECK 3: full-path wikilinks pointing to missing files are unresolved.

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Vault } from "../../../vault";
import { parseWikilinks } from "../../../wikilinks";
import { walkWikiPages } from "../internal/walk-wiki-pages";
import type { CheckResult } from "./types";

export async function checkWikilinks(vault: Vault): Promise<CheckResult> {
  const violations: string[] = [];
  const info: string[] = [];

  for await (const { rel } of walkWikiPages(vault)) {
    const out = await vault.tools.readDocument({ path: rel });
    if (!out.result.ok) continue;
    const doc = out.result.value;

    const links = parseWikilinks(doc.body);
    for (const link of links) {
      if (!link.isFullPath) {
        violations.push(`${rel}: short-form wikilink "${link.target}" (WIKILINKS_ARE_FULLPATH)`);
      } else {
        // Treat the target as a path relative to vault root; add .md if missing.
        const targetPath = link.target.endsWith(".md") ? link.target : `${link.target}.md`;
        const absTarget = join(vault.path, targetPath);
        if (!existsSync(absTarget)) {
          violations.push(`${rel}: unresolved wikilink "${link.target}"`);
        }
      }
    }
  }

  return { violations, info };
}
