import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

test("home upgrade CLI stays lazy and imports only the public intent boundary", async () => {
  const index = await readFile(join(ROOT, "src/cli/index.ts"), "utf8");
  expect(index).toContain('await import("./commands/home-upgrade")');
  expect(index).not.toMatch(/^import .*commands\/home-upgrade/m);

  const adapter = await readFile(join(ROOT, "src/cli/commands/home-upgrade.ts"), "utf8");
  const imports = [...adapter.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
  expect(imports.filter((path) => path.includes("product-host"))).toEqual(["../../product-host/home-upgrade"]);
  expect(imports).toEqual([
    "../../product-host/home-upgrade",
    "../../surface/format",
    "../../surface/resolve-vault",
  ]);
  for (const forbidden of ["cutover", "transaction", "history", "lifecycle", "installation", "artifact"]) {
    expect(adapter).not.toContain(`home-upgrade-${forbidden}`);
    expect(adapter).not.toContain(`home-${forbidden}`);
  }
});
