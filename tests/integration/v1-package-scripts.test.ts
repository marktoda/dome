import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

describe("V1 package scripts", () => {
  test("release check composes implementation gates and M10 readiness", async () => {
    const pkg = JSON.parse(
      await readFile(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};

    expect(scripts["v1:check"]).toContain("bun run typecheck");
    expect(scripts["v1:check"]).toContain("git diff --check");
    expect(scripts["v1:check"]).toContain("bun test");
    expect(scripts["v1:check"]).toContain("bun run v1:smoke");
    expect(scripts["v1:release-check"]).toBe(
      "bun run v1:check && bun run v1:dogfood-preflight -- --require-ready && bun run v1:dogfood-report -- --require-ready",
    );
  });
});
