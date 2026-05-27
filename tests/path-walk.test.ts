import { describe, test, expect } from "bun:test";
import { walkUpForAncestor } from "../src/path-walk";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

describe("walkUpForAncestor", () => {
  test("returns the directory matching the predicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "walk-up-"));
    await mkdir(join(root, "a", "b", "c"), { recursive: true });
    await mkdir(join(root, "a", ".marker"));
    const found = walkUpForAncestor(
      join(root, "a", "b", "c"),
      (dir) => existsSync(join(dir, ".marker")),
    );
    expect(found).toBe(join(root, "a"));
  });

  test("returns null when no ancestor matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "walk-up-none-"));
    await mkdir(join(root, "x"), { recursive: true });
    const found = walkUpForAncestor(join(root, "x"), () => false);
    expect(found).toBe(null);
  });

  test("matches the start directory itself when predicate accepts it", async () => {
    const root = await mkdtemp(join(tmpdir(), "walk-up-self-"));
    await mkdir(join(root, "deep", "subdir"), { recursive: true });
    const found = walkUpForAncestor(
      join(root, "deep", "subdir"),
      (dir) => dir === join(root, "deep", "subdir"),
    );
    expect(found).toBe(join(root, "deep", "subdir"));
  });
});
