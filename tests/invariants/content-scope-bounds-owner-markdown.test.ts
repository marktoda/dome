import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  contentScopeContains,
  defineContentScope,
} from "../../src/core/content-scope";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INVARIANT_DOC = join(
  REPO_ROOT,
  "docs",
  "wiki",
  "invariants",
  "CONTENT_SCOPE_BOUNDS_OWNER_MARKDOWN.md",
);

describe("CONTENT_SCOPE_BOUNDS_OWNER_MARKDOWN lockstep", () => {
  test("invariant doc exists at the canonical path", () => {
    expect(existsSync(INVARIANT_DOC)).toBe(true);
  });

  test("the policy cannot include non-Markdown or Dome/Git private paths", () => {
    const result = defineContentScope({
      version: 1,
      include: ["**"],
      exclude: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(contentScopeContains(result.scope, "owner.md")).toBe(true);
    expect(contentScopeContains(result.scope, "owner.MD")).toBe(false);
    expect(contentScopeContains(result.scope, "image.png")).toBe(false);
    expect(contentScopeContains(result.scope, ".dome/private.md")).toBe(false);
    expect(contentScopeContains(result.scope, ".git/private.md")).toBe(false);
  });

  test("the pure policy module imports no engine, capability, filesystem, or Git machinery", async () => {
    const source = await readFile(join(REPO_ROOT, "src", "core", "content-scope.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports).toEqual(["node:util", "zod", "./glob-match", "./vault-path"]);
  });
});
