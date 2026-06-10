// surface-adapters-dont-import-adapters: the structural fence behind
// docs/wiki/specs/sdk-surface.md §"Consumer surfaces"
// ([[wiki/linters/surface-adapters-dont-import-adapters]]).
//
// Three direction rules over src/{surface,cli,mcp}:
//   1. MCP is adapter-clean — nothing under src/mcp/ imports src/cli/.
//   2. CLI is adapter-clean — nothing under src/cli/ imports src/mcp/,
//      except the host shim src/cli/commands/mcp.ts (reached only via the
//      dispatcher's dynamic import, keeping the CLI's static graph MCP-free).
//   3. The surface layer is below adapters — nothing under src/surface/
//      imports src/cli/ or src/mcp/.

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(dirname(THIS_FILE)));

const CLI_MCP_HOST_SHIM = "src/cli/commands/mcp.ts";

type Rule = {
  readonly name: string;
  readonly fromGlob: string;
  readonly forbiddenPrefix: string;
  readonly exemptFiles: ReadonlySet<string>;
};

const RULES: ReadonlyArray<Rule> = [
  {
    name: "src/mcp must not import src/cli",
    fromGlob: "src/mcp/**/*.ts",
    forbiddenPrefix: "src/cli/",
    exemptFiles: new Set(),
  },
  {
    name: "src/cli must not import src/mcp (host shim excepted)",
    fromGlob: "src/cli/**/*.ts",
    forbiddenPrefix: "src/mcp/",
    exemptFiles: new Set([CLI_MCP_HOST_SHIM]),
  },
  {
    name: "src/surface must not import an adapter",
    fromGlob: "src/surface/**/*.ts",
    forbiddenPrefix: "src/cli/",
    exemptFiles: new Set(),
  },
  {
    name: "src/surface must not import src/mcp",
    fromGlob: "src/surface/**/*.ts",
    forbiddenPrefix: "src/mcp/",
    exemptFiles: new Set(),
  },
];

const IMPORT_PATTERN = /(?:from\s+|import\()"(\.{1,2}\/[^"]+)"/g;

describe("surface adapters don't import adapters", () => {
  for (const rule of RULES) {
    test(rule.name, async () => {
      const violations: string[] = [];
      for await (const file of new Glob(rule.fromGlob).scan(REPO_ROOT)) {
        if (rule.exemptFiles.has(file)) continue;
        const text = await readFile(join(REPO_ROOT, file), "utf8");
        for (const match of text.matchAll(IMPORT_PATTERN)) {
          const resolved = normalize(join(dirname(file), match[1] ?? ""));
          if (resolved.startsWith(rule.forbiddenPrefix)) {
            violations.push(`${file} imports ${match[1]}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

function normalize(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}
