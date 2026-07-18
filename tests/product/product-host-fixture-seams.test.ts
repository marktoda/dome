import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("Product Host integration tests use only owned bounded fixture seams", async () => {
  const source = await readFile(resolve(import.meta.dir, "product-host.test.ts"), "utf8");

  expect(matches(source, /\bfetch\s*\(/g)).toBe(0);
  expect(matches(source, /\.readiness\s*\(/g)).toBe(0);
  expect(matches(source, /\.value\.close\s*\(/g)).toBe(0);
  expect(matches(source, /\bhosts\.splice\s*\(/g)).toBe(0);
  expect(matches(source, /\bstartProductHost\s*\(/g)).toBe(1);
  expect(matches(source, /\bhosts\.push\s*\(/g)).toBe(0);
  expect(matches(source, /\bstartTrackedProductHost\s*\(/g)).toBeGreaterThan(10);
  expect(matches(source, /\bfetchTextWithin\s*\(/g)).toBeGreaterThan(5);
  expect(source).toContain("await closeTrackedProductFixture(first.value, hosts)");
  expect(source).toContain("await cleanupOwnedProductFixtures(hosts, roots");
  expect(source).toContain("return startOwnedProductFixture(");
});

function matches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}
