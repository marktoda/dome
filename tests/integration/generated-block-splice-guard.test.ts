// Structural fence for the generated-block grammar: any non-test source file
// under src/ or assets/extensions/ that constructs or matches a
// generated-block marker (`<!-- <owner>:<block>:start/end -->`) must import
// the grammar primitive at src/core/generated-block.ts — the only sanctioned
// marker implementation. Hand-rolled marker handling is the thrice-shipped
// marker-smuggling bug class (brief questions-pair smuggle, dome.daily marker
// injection, double-promote rule-text escape); the primitive carries the
// line-anchored scan and the body-sanitization guard, so the fence keeps the
// grammar single-implementation. Spec: [[wiki/linters/generated-block-splice-guard]].

import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * A source file "handles markers" when it matches any of:
 *  - `:start -->` / `:end -->` — literal markers AND template-string
 *    constructions (`` `<!-- ${owner}:${block}:start -->` `` still contains
 *    the substring);
 *  - `<!-- dome.` / `<!-- dome:` (whitespace-tolerant) — dome-prefixed
 *    comment literals, dotted or bare owner;
 *  - `<!--\s*dome` as regex source text — files that hand-roll a marker-
 *    matching regex instead of literal marker text.
 */
const MARKER_HANDLING_RE = new RegExp(
  [
    /:(?:start|end) -->/.source,
    /<!--\s*dome[.:]/.source,
    /<!--\\s\*dome/.source,
  ].join("|"),
);

/**
 * An import of the primitive, any path-relative depth:
 * `./generated-block`, `../core/generated-block`,
 * `../../../../src/core/generated-block`, or a packaged
 * `@dome/sdk/core/generated-block` style specifier.
 */
const IMPORT_RE =
  /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']*\bgenerated-block)["']|\bimport\s*\(\s*["']([^"']*\bgenerated-block)["']\s*\)|\bexport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']*\bgenerated-block)["']/;

/** The single implementation of the grammar — the only allow-listed file. */
const ALLOWED_FILES = new Set(["src/core/generated-block.ts"]);

const SWEPT_GLOBS = ["src/**/*.ts", "assets/extensions/**/*.ts"];

describe("generated-block splice guard", () => {
  test("marker-handling source files import the src/core/generated-block primitive", async () => {
    const violations: string[] = [];

    for (const glob of SWEPT_GLOBS) {
      for await (const file of new Glob(glob).scan(".")) {
        if (file.endsWith(".test.ts")) continue;
        if (ALLOWED_FILES.has(file)) continue;
        // readFile, never grep: at least one marker site (brief-shared.ts)
        // legitimately contains a NUL byte in a template string, which makes
        // grep treat the file as binary and silently miss matches.
        const text = await readFile(file, "utf8");
        if (!MARKER_HANDLING_RE.test(text)) continue;
        if (IMPORT_RE.test(text)) continue;
        violations.push(
          `${file}: constructs a generated-block marker but does not import src/core/generated-block — use the grammar primitive (wiki/linters/generated-block-splice-guard)`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  test("the detection regex catches literal, template-string, and regex-source marker construction", () => {
    // Self-test so a refactor cannot quietly hollow out the fence.
    expect(MARKER_HANDLING_RE.test('"<!-- dome.daily:open-loops:start -->"'))
      .toBe(true);
    expect(MARKER_HANDLING_RE.test('"<!-- dome:index:end -->"')).toBe(true);
    // eslint-disable-next-line no-template-curly-in-string
    expect(MARKER_HANDLING_RE.test("`<!-- ${owner}:${block}:start -->`"))
      .toBe(true);
    expect(MARKER_HANDLING_RE.test("/<!--\\s*dome\\./")).toBe(true);
    expect(MARKER_HANDLING_RE.test('line.startsWith("<!--")')).toBe(false);
    expect(MARKER_HANDLING_RE.test("<!-- ordinary html comment -->")).toBe(
      false,
    );
  });
});
