// tests/integration/no-retired-symbol-names-in-specs.test.ts
//
// Pins the no-retired-symbol-names linter spec (docs/wiki/linters/no-retired-symbol-names.md):
// no normative doc may name a symbol in src/retired-symbols.ts RETIRED_SYMBOLS.
//
// Two arms:
// (1) docs surface — walks docs/wiki/**/*.md and asserts zero matches.
// (2) code surface — asserts none of the retired names appears as a public
//     export from any @dome/sdk entrypoint (src/index.ts, src/workflows/index.ts,
//     src/mcp/index.ts, src/cli/index.ts).
//
// Exclusion set: docs/cohesive/reviews/, docs/cohesive/brainstorms/,
// docs/cohesive/delta-ledgers/, docs/cohesive/substrate-discovery/,
// docs/wiki/linters/no-retired-symbol-names.md itself (the canonical home
// of the allow-list), and the §"Linters" subsection of docs/index.md
// (the substrate-catalog one-line summaries).
// See docs/wiki/linters/no-retired-symbol-names.md §"Programmatic detection".

import { describe, test, expect } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { RETIRED_SYMBOL_NAMES } from "../../src/retired-symbols";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const SCAN_ROOTS = [
  join(REPO_ROOT, "docs", "wiki"),
];

const EXCLUDED_PATHS = [
  join(REPO_ROOT, "docs", "wiki", "linters", "no-retired-symbol-names.md"),
];

const EXCLUDED_DIRS = [
  join(REPO_ROOT, "docs", "cohesive", "reviews"),
  join(REPO_ROOT, "docs", "cohesive", "brainstorms"),
  join(REPO_ROOT, "docs", "cohesive", "delta-ledgers"),
  join(REPO_ROOT, "docs", "cohesive", "substrate-discovery"),
];

async function walk(dir: string): Promise<string[]> {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (EXCLUDED_DIRS.some(d => full.startsWith(d))) continue;
    const st = await stat(full);
    if (st.isDirectory()) {
      out = out.concat(await walk(full));
    } else if (entry.endsWith(".md") && !EXCLUDED_PATHS.includes(full)) {
      out.push(full);
    }
  }
  return out;
}

describe("no-retired-symbol-names-in-specs (lockstep)", async () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    files.push(...(await walk(root)));
  }

  for (const file of files) {
    test(`${relative(REPO_ROOT, file)} contains no retired symbol names`, async () => {
      const text = await readFile(file, "utf8");
      const hits: string[] = [];
      for (const name of RETIRED_SYMBOL_NAMES) {
        // Match as whole-word.
        const re = new RegExp(`\\b${name}\\b`);
        if (re.test(text)) hits.push(name);
      }
      expect(hits,
        `Retired symbols found in ${relative(REPO_ROOT, file)}: ${hits.join(", ")}.\n` +
        `See docs/wiki/linters/no-retired-symbol-names.md for the allow-list and exclusion rules.`,
      ).toEqual([]);
    });
  }

  test("no @dome/sdk public entrypoint re-exports a retired symbol", async () => {
    const entrypoints = [
      join(REPO_ROOT, "src", "index.ts"),
      join(REPO_ROOT, "src", "workflows", "index.ts"),
      join(REPO_ROOT, "src", "mcp", "index.ts"),
      join(REPO_ROOT, "src", "cli", "index.ts"),
    ];
    const hits: { file: string; name: string }[] = [];
    for (const ep of entrypoints) {
      const text = await readFile(ep, "utf8");
      for (const name of RETIRED_SYMBOL_NAMES) {
        const re = new RegExp(`\\bexport\\b[^;]*\\b${name}\\b`);
        if (re.test(text)) hits.push({ file: relative(REPO_ROOT, ep), name });
      }
    }
    expect(hits).toEqual([]);
  });
});
