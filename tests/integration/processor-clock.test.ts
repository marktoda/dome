// Structural fence for processor determinism: bundle code must not read the
// host wall clock or randomness. A processor's contract is same (snapshot,
// input) → same effects; `ctx.now()` is the only sanctioned clock (the
// runtime pins it per invocation, and tests inject it). An argless
// `new Date()` or `Date.now()` smuggles the host clock into effect output —
// the refresh-updated processor shipped exactly that bug, with run-time
// dates landing in PatchEffect content. `new Date(value)` (parsing a
// snapshot-derived or input-derived timestamp) remains fine.

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const BANNED = [
  { re: /\bnew Date\(\s*\)/, label: "argless new Date()" },
  { re: /\bDate\.now\(\s*\)/, label: "Date.now()" },
  { re: /\bMath\.random\(\s*\)/, label: "Math.random()" },
] as const;

const SWEPT_GLOBS = ["assets/extensions/**/*.ts"];

describe("processor clock fence", () => {
  test("bundle code reads time only through ctx.now() and never randomness", async () => {
    const violations: string[] = [];
    for (const glob of SWEPT_GLOBS) {
      for await (const file of new Glob(glob).scan(".")) {
        if (file.endsWith(".test.ts")) continue;
        const text = await readFile(file, "utf8");
        for (const { re, label } of BANNED) {
          if (re.test(text)) {
            violations.push(
              `${file}: uses ${label} — processors must derive time from ctx.now() (and never use randomness)`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("the detection regexes catch the banned forms and allow parsing", () => {
    // Self-test so a refactor cannot quietly hollow out the fence.
    const argless = BANNED[0].re;
    expect(argless.test("const now = new Date();")).toBe(true);
    expect(argless.test("new Date( )")).toBe(true);
    expect(argless.test('new Date(info.lastChangedAt)')).toBe(false);
    expect(BANNED[1].re.test("Date.now()")).toBe(true);
    expect(BANNED[2].re.test("Math.random()")).toBe(true);
  });
});
