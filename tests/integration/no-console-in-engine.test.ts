import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const FORBIDDEN_CONSOLE_PATTERN = /\bconsole\.(?:log|warn|error)\(/;

describe("engine host-boundary purity", () => {
  test("engine and substrate modules do not write directly to console", async () => {
    const violations: string[] = [];
    for await (const file of new Glob("src/{engine,processors,projections,outbox,ledger}/**/*.ts").scan(".")) {
      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (FORBIDDEN_CONSOLE_PATTERN.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
