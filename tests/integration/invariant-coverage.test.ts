// AC3 meta-test: every named invariant has at least one test file asserting
// its enforcement. This catches the failure mode "we added a new invariant
// to the SDK but forgot to write a test".
//
// File naming convention: SOME_INVARIANT_NAME -> some-invariant-name.test.ts
// under tests/invariants/.

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { INVARIANTS } from "../../src/types";

describe("invariant test coverage (AC3)", () => {
  for (const [_key, name] of Object.entries(INVARIANTS)) {
    test(`${name} has a corresponding tests/invariants/<...>.test.ts`, () => {
      // SOME_INVARIANT_NAME -> some-invariant-name.test.ts
      const fileBase = name.toLowerCase().replace(/_/g, "-");
      const filePath = join(__dirname, "..", "invariants", `${fileBase}.test.ts`);
      expect(existsSync(filePath)).toBe(true);
    });
  }
});
