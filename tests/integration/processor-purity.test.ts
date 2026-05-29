import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const FORBIDDEN_MODULES = new Set([
  "bun",
  "bun:sqlite",
  "isomorphic-git",
  "node:child_process",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:https",
  "node:net",
]);

const FORBIDDEN_CALLS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  { name: "Bun.write", pattern: /\bBun\.write\(/ },
  { name: "writeFile", pattern: /\.writeFile(?:Sync)?\(|\bwriteFile\(/ },
  { name: "appendFile", pattern: /\.appendFile(?:Sync)?\(|\bappendFile\(/ },
  { name: "unlink", pattern: /\.unlink(?:Sync)?\(|\bunlink\(/ },
  { name: "rename", pattern: /\.rename(?:Sync)?\(|\brename\(/ },
  { name: "mkdir", pattern: /\.mkdir(?:Sync)?\(|\bmkdir\(/ },
  { name: "fetch", pattern: /\bfetch\(/ },
  {
    name: "sqlite mutation",
    pattern: /\.(?:exec|run)\(\s*['"`]\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i,
  },
  {
    name: "git mutation",
    pattern: /\bgit\.(?:commit|add|checkout|merge|push|writeRef|writeBlob|writeTree)\(/,
  },
];

const IMPORT_RE =
  /\bimport\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

describe("processor purity", () => {
  test("first-party processors do not import mutation-capable modules or call mutation APIs", async () => {
    const violations: string[] = [];

    for await (const file of new Glob(
      "assets/extensions/*/processors/**/*.ts",
    ).scan(".")) {
      const text = await readFile(file, "utf8");
      if (text.startsWith("// @engine-internal:")) continue;

      for (const match of text.matchAll(IMPORT_RE)) {
        const typeOnly = match[1] !== undefined;
        const moduleName = match[2] ?? match[3];
        if (typeOnly || moduleName === undefined) continue;
        if (FORBIDDEN_MODULES.has(moduleName)) {
          violations.push(`${file}: imports ${moduleName}`);
        }
      }

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        for (const forbidden of FORBIDDEN_CALLS) {
          if (forbidden.pattern.test(line)) {
            violations.push(
              `${file}:${i + 1}: ${forbidden.name}: ${line.trim()}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
