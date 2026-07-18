// surface-adapters-dont-import-adapters: the structural fence behind
// docs/wiki/specs/sdk-surface.md §"Consumer surfaces"
// ([[wiki/linters/surface-adapters-dont-import-adapters]]).
//
// Direction rules over src/{surface,cli,mcp,http}:
//   1. Adapters are adapter-clean — nothing under src/mcp/ or src/http/
//      imports src/cli/, and they don't import each other.
//   2. CLI is adapter-clean — nothing under src/cli/ imports src/mcp/ or
//      src/http/, except the host shims src/cli/commands/{mcp,http}.ts
//      (reached only via the dispatcher's dynamic import, keeping the
//      CLI's static graph adapter-free).
//   3. The surface layer is below adapters — nothing under src/surface/
//      imports src/cli/, src/mcp/, or src/http/.
//   4. Shared public-Vault adapter plumbing stays on the public wrapper seam —
//      src/surface/adapter.ts never reaches through it into engine/host.

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(dirname(THIS_FILE)));

const CLI_MCP_HOST_SHIM = "src/cli/commands/mcp.ts";
const CLI_HTTP_HOST_SHIM = "src/cli/commands/http.ts";

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
  {
    name: "src/http must not import src/cli",
    fromGlob: "src/http/**/*.ts",
    forbiddenPrefix: "src/cli/",
    exemptFiles: new Set(),
  },
  {
    name: "src/cli must not import src/http (host shim excepted)",
    fromGlob: "src/cli/**/*.ts",
    forbiddenPrefix: "src/http/",
    exemptFiles: new Set([CLI_HTTP_HOST_SHIM]),
  },
  {
    name: "src/surface must not import src/http",
    fromGlob: "src/surface/**/*.ts",
    forbiddenPrefix: "src/http/",
    exemptFiles: new Set(),
  },
  {
    name: "src/surface/adapter must not bypass the public Vault wrapper",
    fromGlob: "src/surface/adapter.ts",
    forbiddenPrefix: "src/engine/host/",
    exemptFiles: new Set(),
  },
  {
    name: "src/http must not import src/mcp",
    fromGlob: "src/http/**/*.ts",
    forbiddenPrefix: "src/mcp/",
    exemptFiles: new Set(),
  },
  {
    name: "src/mcp must not import src/http",
    fromGlob: "src/mcp/**/*.ts",
    forbiddenPrefix: "src/http/",
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
