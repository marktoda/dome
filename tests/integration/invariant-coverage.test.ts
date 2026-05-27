import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { INVARIANTS } from "../../src/types";

describe("invariant test coverage (AC3)", () => {
  for (const [_key, name] of Object.entries(INVARIANTS)) {
    test(`${name} has a corresponding tests/invariants/<...>.test.ts`, () => {
      const fileBase = name.toLowerCase().replace(/_/g, "-");
      const filePath = join(__dirname, "..", "invariants", `${fileBase}.test.ts`);
      expect(existsSync(filePath)).toBe(true);
    });

    test(`${name} lockstep file is not a no-op (has expect against state OR dynamic import)`, async () => {
      const fileBase = name.toLowerCase().replace(/_/g, "-");
      const filePath = join(__dirname, "..", "invariants", `${fileBase}.test.ts`);
      const text = await readFile(filePath, "utf8");
      // Reject the expect(true).toBe(true) no-op pattern.
      const isStubNoOp = /expect\(true\)\.toBe\(true\)/.test(text);
      expect(isStubNoOp,
        `tests/invariants/${fileBase}.test.ts is an expect(true).toBe(true) no-op. ` +
        `Use the delegating-stub shape per docs/wiki/specs/sdk-surface.md §"Off-matrix lockstep convention".`,
      ).toBe(false);
      // Require either an expect() referencing a non-literal value OR a dynamic import.
      const hasExpect = /\bexpect\s*\([^)]*[a-z]/.test(text);
      const hasDynamicImport = /\bawait\s+import\s*\(["']/.test(text);
      expect(hasExpect || hasDynamicImport,
        `tests/invariants/${fileBase}.test.ts must contain at least one expect() against vault state ` +
        `OR an await import("...") referencing an enforcement test. ` +
        `See docs/wiki/specs/sdk-surface.md §"Off-matrix lockstep convention".`,
      ).toBe(true);
    });
  }
});
