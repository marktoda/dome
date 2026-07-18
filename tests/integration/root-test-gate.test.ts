import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

test("local, CI, and contributor root gates use the per-file runner", async () => {
  const [packageText, workflow, readme, agents] = await Promise.all([
    readFile(resolve(REPO_ROOT, "package.json"), "utf8"),
    readFile(resolve(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(resolve(REPO_ROOT, "README.md"), "utf8"),
    readFile(resolve(REPO_ROOT, "AGENTS.md"), "utf8"),
  ]);
  const pkg = JSON.parse(packageText) as { scripts?: Record<string, string> };

  expect(pkg.scripts?.test).toBe("bun scripts/test-root.ts");
  expect(pkg.scripts?.["v1:check"]).toContain("bun run test");
  expect(pkg.scripts?.["v1:check"]).not.toContain("bun test ./tests");
  expect(workflow).toContain("name: Test SDK and product runtime");
  expect(workflow).toContain("run: bun run test");
  expect(workflow).not.toContain("run: bun test ./tests");
  expect(readme).toContain("bun run test");
  expect(readme).toContain("runs each file in its own fresh Bun process");
  expect(agents).toContain("`bun run test`");
  expect(agents).toContain("executes each file in its own fresh Bun process");
  const runner = await readFile(resolve(REPO_ROOT, "scripts", "test-root.ts"), "utf8");
  expect(runner).toContain("Bun.spawn(rootTestCommand(file)");
  expect(runner).toContain('process.on("SIGINT"');
  expect(runner).toContain('process.on("SIGTERM"');
  expect(runner).toContain("await superviseRootTestChild(child, { interrupted })");
  expect(runner).toContain("ROOT_TEST_FILE_TIMEOUT_MS = 5 * 60_000");
  expect(runner).toContain("child.kill(15)");
  expect(runner).toContain("child.kill(9)");
});
