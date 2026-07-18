import { describe, expect, test } from "bun:test";
import {
  canonicalContentScopeSchema,
  CONTENT_SCOPE_MAX_ERRORS,
  CONTENT_SCOPE_MAX_GLOBS,
  contentScopeContains,
  defineContentScope,
  selectContentScope,
  type ContentScope,
} from "../../src/core/content-scope";
import { globMatch as neutralGlobMatch } from "../../src/core/glob-match";
import { globMatch as compatibilityGlobMatch } from "../../src/engine/core/glob-cache";

function scope(input: unknown): ContentScope {
  const result = defineContentScope(input);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.scope;
}

function permutations<T>(values: ReadonlyArray<T>): T[][] {
  if (values.length < 2) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)])
      .map((tail) => [value, ...tail]));
}

describe("ContentScope contract", () => {
  test("canonicalizes unordered duplicate patterns and freezes the complete value", () => {
    for (const include of permutations(["wiki/**/*.md", "**/*.md", "wiki/**/*.md"])) {
      const value = scope({
        version: 1,
        include,
        exclude: ["private/**", "drafts/**", "private/**"],
      });
      expect({ version: value.version, include: value.include, exclude: value.exclude }).toEqual({
        version: 1,
        include: ["**/*.md", "wiki/**/*.md"],
        exclude: ["drafts/**", "private/**"],
      });
    }

    const value = scope({
      version: 1,
      include: ["**/*.md"],
      exclude: [],
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.include)).toBe(true);
    expect(Object.isFrozen(value.exclude)).toBe(true);
  });

  test("the revision-bound schema rejects non-canonical order and duplicates", () => {
    expect(canonicalContentScopeSchema.safeParse({
      version: 1,
      include: ["wiki/**", "**/*.md"],
      exclude: [],
    }).success).toBe(false);
    expect(canonicalContentScopeSchema.safeParse({
      version: 1,
      include: ["**/*.md", "**/*.md"],
      exclude: [],
    }).success).toBe(false);
  });

  test("returns bounded Result-style errors and never throws for malformed input", () => {
    const malformed = [
      "",
      "/wiki/**/*.md",
      "wiki/",
      "wiki\\*.md",
      "wiki//*.md",
      "./*.md",
      "../*.md",
      "wiki/\0.md",
      "x".repeat(8_193),
    ];

    for (const pattern of malformed) {
      const result = defineContentScope({ version: 1, include: [pattern], exclude: [] });
      expect(result.ok, pattern).toBe(false);
      if (!result.ok) {
        expect(Object.isFrozen(result.errors)).toBe(true);
        expect(result.errors[0]).toMatchObject({ code: "invalid-glob", path: "include.0" });
      }
    }

    const unsupported = defineContentScope({ version: 2, include: ["**/*.md"], exclude: [] });
    expect(unsupported).toMatchObject({ ok: false, errors: [{ code: "unsupported-version" }] });
    expect(defineContentScope({ version: 1, include: [], exclude: [] }))
      .toMatchObject({ ok: false, errors: [{ code: "missing-include" }] });
    expect(defineContentScope(null)).toMatchObject({ ok: false, errors: [{ code: "invalid-shape" }] });
    expect(defineContentScope({ version: 1, include: ["**/*.md"], exclude: [], extra: true }))
      .toMatchObject({ ok: false, errors: [{ code: "invalid-shape" }] });
  });

  test("bounds raw include and exclude arrays before de-duplication", () => {
    const tooMany = Array.from({ length: CONTENT_SCOPE_MAX_GLOBS + 1 }, () => "**/*.md");
    expect(defineContentScope({ version: 1, include: tooMany, exclude: [] }))
      .toMatchObject({ ok: false, errors: [{ code: "too-many-globs" }] });
    expect(defineContentScope({ version: 1, include: ["**/*.md"], exclude: tooMany }))
      .toMatchObject({ ok: false, errors: [{ code: "too-many-globs" }] });
  });

  test("preflights hostile arrays before element validation and bounds all returned errors", () => {
    const malformed = Array.from({ length: 1_000 }, (_, index) => `bad\\${index}`);
    const result = defineContentScope({ version: 1, include: malformed, exclude: malformed });
    expect(result).toMatchObject({
      ok: false,
      errors: [
        { code: "too-many-globs", path: "include" },
        { code: "too-many-globs", path: "exclude" },
      ],
    });
    expect(canonicalContentScopeSchema.safeParse({
      version: 1,
      include: malformed,
      exclude: malformed,
    }).error?.issues).toHaveLength(2);

    const boundedMalformed = Array.from(
      { length: CONTENT_SCOPE_MAX_GLOBS },
      (_, index) => `bad\\${index}`,
    );
    const bounded = defineContentScope({
      version: 1,
      include: boundedMalformed,
      exclude: boundedMalformed,
    });
    expect(bounded.ok).toBe(false);
    if (!bounded.ok) expect(bounded.errors).toHaveLength(CONTENT_SCOPE_MAX_ERRORS);

    let getterCalls = 0;
    const activeShape = Object.defineProperty(
      { version: 1, exclude: [] },
      "include",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return ["**/*.md"];
        },
      },
    );
    expect(defineContentScope(activeShape))
      .toMatchObject({ ok: false, errors: [{ code: "invalid-shape" }] });
    expect(canonicalContentScopeSchema.safeParse(activeShape).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  test("validates only passive descriptor snapshots for outer proxies and array elements", () => {
    let objectTrapCalls = 0;
    const trappedObject = new Proxy(
      { version: 1, include: ["**/*.md"], exclude: [] },
      {
        get() {
          objectTrapCalls += 1;
          throw new Error("outer get trap must not run");
        },
        getOwnPropertyDescriptor() {
          objectTrapCalls += 1;
          throw new Error("outer descriptor trap must not run");
        },
        ownKeys() {
          objectTrapCalls += 1;
          throw new Error("outer ownKeys trap must not run");
        },
      },
    );
    expect(defineContentScope(trappedObject)).toMatchObject({
      ok: false,
      errors: [{ code: "invalid-shape" }],
    });
    expect(canonicalContentScopeSchema.safeParse(trappedObject).success).toBe(false);
    expect(objectTrapCalls).toBe(0);

    let elementGetterCalls = 0;
    const activeArray = ["placeholder"];
    Object.defineProperty(activeArray, "0", {
      configurable: true,
      enumerable: true,
      get() {
        elementGetterCalls += 1;
        throw new Error("array element getter must not run");
      },
    });
    const activeElement = { version: 1, include: activeArray, exclude: [] };
    expect(defineContentScope(activeElement)).toMatchObject({
      ok: false,
      errors: [{ code: "invalid-shape", path: "include" }],
    });
    expect(canonicalContentScopeSchema.safeParse(activeElement).success).toBe(false);
    expect(elementGetterCalls).toBe(0);
  });

  test("rejects a 100k-key array Proxy before any hostile trap and bounds plain extra-key errors", () => {
    let proxyTrapCalls = 0;
    const virtualKeys = Array.from({ length: 100_000 }, (_, index) => String(index));
    const lyingArray = new Proxy([], {
      get(target, property, receiver) {
        proxyTrapCalls += 1;
        if (property === "length") return 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        proxyTrapCalls += 1;
        if (property === "length") return Reflect.getOwnPropertyDescriptor(target, property);
        return { configurable: true, enumerable: true, value: "bad\\glob", writable: true };
      },
      ownKeys() {
        proxyTrapCalls += 1;
        return ["length", ...virtualKeys];
      },
    });
    const proxyInput = { version: 1, include: lyingArray, exclude: [] };
    expect(defineContentScope(proxyInput)).toMatchObject({
      ok: false,
      errors: [{ code: "invalid-shape", path: "include" }],
    });
    expect(canonicalContentScopeSchema.safeParse(proxyInput).success).toBe(false);
    expect(proxyTrapCalls).toBe(0);

    const extraKeys: Record<string, unknown> = {
      version: 1,
      include: ["**/*.md"],
      exclude: [],
    };
    for (let index = 0; index < 100_000; index += 1) extraKeys[`extra-${index}`] = index;
    const extraResult = defineContentScope(extraKeys);
    expect(extraResult).toMatchObject({
      ok: false,
      errors: [{ code: "invalid-shape", path: "$" }],
    });
    if (!extraResult.ok) {
      expect(extraResult.errors).toHaveLength(1);
      expect(Object.isFrozen(extraResult.errors)).toBe(true);
    }
    expect(canonicalContentScopeSchema.safeParse(extraKeys).error?.issues).toHaveLength(1);
  });
});

describe("ContentScope matching", () => {
  test("pins Bun.Glob root, nested, dot-path, brace, class, and case semantics", () => {
    const allMarkdown = scope({ version: 1, include: ["**/*.md"], exclude: [] });
    for (const path of ["README.md", "wiki/note.md", ".hidden.md", "wiki/.hidden.md"]) {
      expect(contentScopeContains(allMarkdown, path), path).toBe(true);
    }
    for (const path of ["README.MD", "wiki/note.Md", "wiki/image.png", "wiki/directory.md/file.txt"]) {
      expect(contentScopeContains(allMarkdown, path), path).toBe(false);
    }

    const language = scope({
      version: 1,
      include: ["{notes,wiki}/**/[a-z]*.md"],
      exclude: [],
    });
    expect(contentScopeContains(language, "wiki/a.md")).toBe(true);
    expect(contentScopeContains(language, "notes/nested/zebra.md")).toBe(true);
    expect(contentScopeContains(language, "wiki/A.md")).toBe(false);
    expect(contentScopeContains(language, "other/a.md")).toBe(false);
  });

  test("pins Bun.Glob literal metacharacter character-class semantics", () => {
    const literals = scope({
      version: 1,
      include: [
        "notes/[?]draft.md",
        "notes/[*]draft.md",
        "notes/[[]draft].md",
        "notes/[[]draft[]].md",
        "notes/[{]draft[}].md",
      ],
      exclude: [],
    });
    for (const path of [
      "notes/?draft.md",
      "notes/*draft.md",
      "notes/[draft].md",
      "notes/{draft}.md",
    ]) {
      expect(contentScopeContains(literals, path), path).toBe(true);
    }
    expect(contentScopeContains(literals, "notes/draft.md")).toBe(false);

    // Bun.Glob accepts unmatched opening metacharacters as valid patterns;
    // version 1 delegates syntax acceptance rather than inventing a parser.
    expect(defineContentScope({
      version: 1,
      include: ["notes/{draft.md", "notes/[draft.md"],
      exclude: [],
    }).ok).toBe(true);
  });

  test("exclusion wins and the private floor cannot be overridden", () => {
    const value = scope({
      version: 1,
      include: ["**/*.md", ".dome/**/*.md", ".git/**/*.md"],
      exclude: ["private/**", "wiki/drafts/**"],
    });
    expect(contentScopeContains(value, "wiki/live.md")).toBe(true);
    expect(contentScopeContains(value, "wiki/drafts/idea.md")).toBe(false);
    expect(contentScopeContains(value, "private/secret.md")).toBe(false);
    expect(contentScopeContains(value, ".dome/config.md")).toBe(false);
    expect(contentScopeContains(value, ".git/hooks/readme.md")).toBe(false);
    expect(contentScopeContains(value, ".dome-notes/readme.md")).toBe(true);
  });

  test("selection canonicalizes, de-duplicates, rejects unsafe paths, and sorts", () => {
    const value = scope({ version: 1, include: ["**/*.md"], exclude: ["attic/**"] });
    expect(selectContentScope(value, [
      "z.md",
      "wiki//b.md",
      "wiki/b.md",
      "attic/old.md",
      "../outside.md",
      "/absolute.md",
      "a.MD",
      "a.md",
    ]).map(String)).toEqual(["a.md", "wiki/b.md", "z.md"]);
  });

  test("candidate permutations always produce the same selection", () => {
    const value = scope({
      version: 1,
      include: ["{notes,wiki}/**/*.md"],
      exclude: ["**/private/**"],
    });
    const corpus = [
      "wiki/b.md",
      "notes/a.md",
      "wiki/private/c.md",
      "other/d.md",
      "notes/nested/e.md",
    ];
    const expected = ["notes/a.md", "notes/nested/e.md", "wiki/b.md"];
    for (const permutation of permutations(corpus)) {
      expect(selectContentScope(value, permutation).map(String)).toEqual(expected);
    }
  });

  test("the engine compatibility path re-exports the one neutral matcher", () => {
    expect(compatibilityGlobMatch).toBe(neutralGlobMatch);
    expect(compatibilityGlobMatch("**/*.md", "wiki/page.md")).toBe(true);
  });
});
