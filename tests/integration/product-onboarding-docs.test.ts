import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe("canonical product onboarding", () => {
  test("the getting-started journey begins and ends with Dome Home", async () => {
    const guide = await readFile(join(REPO_ROOT, "docs", "getting-started.md"), "utf8");

    for (const required of [
      "build:home-artifact",
      "home setup configure",
      "home install",
      "devices pair",
      "http://127.0.0.1:3663/",
      "home upgrade",
      "backup create",
      "backup restore",
    ]) {
      expect(guide).toContain(required);
    }

    for (const obsoleteRecipe of [
      "dome install --env",
      "DOME_HTTP_TOKEN",
      "dome http --",
      "dome recipe ios",
      "ANTHROPIC_API_KEY=",
      "git pull` + `dome restart",
    ]) {
      expect(guide).not.toContain(obsoleteRecipe);
    }
  });

  test("the README names Home as the product and links the canonical guide", async () => {
    const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toContain("Dome Home is the product");
    expect(readme).toContain("docs/getting-started.md");
    expect(readme).toContain("There is not yet a public download");
    expect(readme).not.toContain("clone → vault → daemon");
  });
});
