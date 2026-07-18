import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../..");

describe("setup CLI seam", () => {
  test("setup and init delegate vault construction to one adaptation Module", async () => {
    const [setup, init, adaptation] = await Promise.all([
      readFile(join(ROOT, "src/cli/commands/setup.ts"), "utf8"),
      readFile(join(ROOT, "src/cli/commands/init.ts"), "utf8"),
      readFile(join(ROOT, "src/setup/vault-adaptation.ts"), "utf8"),
    ]);
    expect(setup).toContain("adaptVault(");
    expect(init).toContain("adaptVault({");
    expect(init).toContain('mode: "compatibility-init"');
    expect(init).not.toContain("initRepo");
    expect(adaptation).toContain("createSetupPlanApplier");
    expect(adaptation).toContain("compileSetupPlan");
  });

  test("only the init adapter selects distribution-aware product evidence", async () => {
    const [setup, adaptation, init] = await Promise.all([
      readFile(join(ROOT, "src/cli/commands/setup.ts"), "utf8"),
      readFile(join(ROOT, "src/setup/vault-adaptation.ts"), "utf8"),
      readFile(join(ROOT, "src/cli/commands/init.ts"), "utf8"),
    ]);
    expect(setup).not.toContain("init-product");
    expect(adaptation).not.toContain("init-product");
    expect(init).toContain("discoverInitProduct");
    const callsites: string[] = [];
    for await (const path of new Bun.Glob("src/**/*.ts").scan({ cwd: ROOT, absolute: true })) {
      if (path.endsWith("/setup/init-product.ts")) continue;
      if ((await readFile(path, "utf8")).includes("discoverInitProduct")) {
        callsites.push(relative(ROOT, path));
      }
    }
    expect(callsites).toEqual(["src/cli/commands/init.ts"]);
  });
});
