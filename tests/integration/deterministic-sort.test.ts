// Structural fence for deterministic string ordering: no source file under
// src/ or assets/extensions/ may call bare `localeCompare`. No-argument
// localeCompare collates through the host's default ICU locale, so sort
// order varies across machines and ICU versions — which silently breaks
// processor idempotency, the fixed-point loop, and rebuild equivalence the
// moment a non-ASCII string reaches an Effect, a projection row, or a
// rendered patch. The sanctioned helper is `compareStrings` in
// src/core/compare.ts (UTF-16 code-unit order: total, stable,
// environment-independent).

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const LOCALE_COMPARE_RE = /\blocaleCompare\b/;

/** The helper's own doc comment names the banned method; nothing else may. */
const ALLOWED_FILES = new Set(["src/core/compare.ts"]);

const SWEPT_GLOBS = ["src/**/*.ts", "assets/extensions/**/*.ts"];

describe("deterministic sort fence", () => {
  test("no source file calls localeCompare — use src/core/compare.ts compareStrings", async () => {
    const violations: string[] = [];
    for (const glob of SWEPT_GLOBS) {
      for await (const file of new Glob(glob).scan(".")) {
        if (file.endsWith(".test.ts")) continue;
        if (ALLOWED_FILES.has(file)) continue;
        const text = await readFile(file, "utf8");
        if (!LOCALE_COMPARE_RE.test(text)) continue;
        violations.push(
          `${file}: calls localeCompare — host-locale collation is non-deterministic; use compareStrings from src/core/compare`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  test("compareStrings is a total, deterministic order", async () => {
    const { compareStrings } = await import("../../src/core/compare");
    expect(compareStrings("a", "b")).toBe(-1);
    expect(compareStrings("b", "a")).toBe(1);
    expect(compareStrings("a", "a")).toBe(0);
    // Code-unit order, NOT locale order: "Z" < "a" by code unit — pinned so
    // a future "fix" toward locale-aware collation fails loudly here.
    expect(compareStrings("Z", "a")).toBe(-1);
    // Non-ASCII: é (U+00E9) sorts after z (U+007A) by code unit, even
    // though most locales collate it next to e.
    expect(compareStrings("é", "z")).toBe(1);
  });
});
