// Pins CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY (axiom, bundle-enforced).
//
// The @dome/sdk core entrypoint (src/index.ts) must not statically pull
// @anthropic-ai/sdk, ai (Vercel AI SDK), or @modelcontextprotocol/sdk
// into its static import graph. A regression — e.g., re-exporting
// runWorkflow from src/index.ts — would static-import `ai`; this test
// catches the chain before merge.
//
// Mechanism: walk the STATIC import graph from src/index.ts
// breadth-first, reading each .ts file's `import ... from "<spec>"` and
// `export ... from "<spec>"` statements. If any spec matches the
// forbidden set, fail with the chain.
//
// Dynamic imports (`await import(...)`) are intentionally NOT followed.
// They live in opt-in code paths the consumer reaches only by exercising
// the relevant feature — e.g., the yaml-loader's dynamic import of
// runWorkflow only fires when a vault has a declarative intake hook
// matching an event. Tree-shake-aware bundlers (esbuild, Rollup, Bun)
// split dynamic imports into separate chunks; a consumer that doesn't
// register YAML intake hooks never pulls runWorkflow's chunk. The
// axiom is about the STATIC bundling boundary; dynamic feature opt-ins
// are correct by construction.

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const FORBIDDEN = new Set([
  "ai",
  "@ai-sdk/anthropic",
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
]);

const FORBIDDEN_PREFIX = [
  "@modelcontextprotocol/sdk/",
  "@ai-sdk/",
];

function isForbidden(spec: string): boolean {
  if (FORBIDDEN.has(spec)) return true;
  return FORBIDDEN_PREFIX.some(p => spec.startsWith(p));
}

const IMPORT_REGEX = /(?:^|\n)\s*(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;

function extractImports(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(IMPORT_REGEX)) specs.push(m[1]!);
  // Dynamic imports (`await import("...")`) are intentionally not extracted;
  // see the file header for the rationale.
  return specs;
}

interface WalkResult {
  visited: string[];
  forbiddenHits: { spec: string; via: string[] }[];
}

async function walkImports(entrypoint: string): Promise<WalkResult> {
  const visited = new Set<string>();
  const queue: { file: string; via: string[] }[] = [{ file: entrypoint, via: [] }];
  const forbiddenHits: { spec: string; via: string[] }[] = [];

  while (queue.length > 0) {
    const { file, via } = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }

    const specs = extractImports(source);
    for (const spec of specs) {
      if (isForbidden(spec)) {
        forbiddenHits.push({ spec, via: [...via, file] });
        continue;
      }
      // Skip node: built-ins and other bare specifiers we don't trace.
      if (spec.startsWith("node:")) continue;
      // Relative imports — resolve to a .ts file under src/ and walk into it.
      if (spec.startsWith(".")) {
        const baseDir = dirname(file);
        const candidates = [
          resolve(baseDir, `${spec}.ts`),
          resolve(baseDir, `${spec}/index.ts`),
          resolve(baseDir, spec),
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            queue.push({ file: candidate, via: [...via, file] });
            break;
          }
        }
      }
      // Other bare specifiers (chokidar, zod, yaml, gray-matter, etc.) are
      // dependencies that ship in the bundle but aren't traced further —
      // walking into node_modules is out of scope for this lightweight check.
    }
  }

  return { visited: [...visited], forbiddenHits };
}

describe("CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY (bundle-enforced)", () => {
  test("src/index.ts transitive imports exclude @anthropic-ai/sdk, ai, @modelcontextprotocol/sdk", async () => {
    const entrypoint = join(import.meta.dir, "..", "..", "src", "index.ts");
    const { visited, forbiddenHits } = await walkImports(entrypoint);
    if (forbiddenHits.length > 0) {
      const formatted = forbiddenHits.map(h =>
        `  - ${h.spec}\n    via:\n${h.via.map(v => `      ${v}`).join("\n")}`
      ).join("\n\n");
      throw new Error(`Forbidden imports reachable from src/index.ts:\n${formatted}`);
    }
    expect(forbiddenHits).toEqual([]);
    // Sanity check — we actually walked into the codebase.
    expect(visited.length).toBeGreaterThan(10);
  });
});
