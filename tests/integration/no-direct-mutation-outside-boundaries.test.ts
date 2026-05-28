import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const ALLOWED_DIRS = [
  "src/engine/",
  "src/projections/",
  "src/ledger/",
  "src/outbox/",
];

const ALLOWED_FILES = new Set([
  "src/git.ts",
  "src/workflow-commit.ts",
  "src/cli/commands/init.ts",
]);

const FORBIDDEN_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  { name: "Bun.write", pattern: /\bBun\.write\(/ },
  { name: "writeFile", pattern: /\.writeFile(?:Sync)?\(|\bwriteFile\(/ },
  { name: "appendFile", pattern: /\.appendFile(?:Sync)?\(|\bappendFile\(/ },
  { name: "unlink", pattern: /\.unlink(?:Sync)?\(|\bunlink\(/ },
  { name: "rename", pattern: /\.rename(?:Sync)?\(|\brename\(/ },
  { name: "mkdir", pattern: /\.mkdir(?:Sync)?\(|\bmkdir\(/ },
  {
    name: "sqlite mutation",
    pattern: /\.(?:exec|run)\(\s*['"`]\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i,
  },
  {
    name: "git mutation",
    pattern: /\bgit\.(?:commit|add|checkout|merge|push|writeRef|writeBlob|writeTree)\(/,
  },
];

describe("no direct mutation outside engine boundaries", () => {
  test("source files outside approved mutation boundaries do not call write APIs", async () => {
    const violations: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      if (isAllowedMutationBoundary(file)) continue;
      const text = await readFile(file, "utf8");
      if (text.startsWith("// @engine-internal:")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        for (const forbidden of FORBIDDEN_PATTERNS) {
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

function isAllowedMutationBoundary(file: string): boolean {
  return (
    ALLOWED_DIRS.some((dir) => file.startsWith(dir)) ||
    ALLOWED_FILES.has(file)
  );
}
