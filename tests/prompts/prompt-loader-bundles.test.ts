import { describe, test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { PromptLoader } from "../../src/prompts/prompt-loader";
import { makeTestVault } from "../helpers/make-test-vault";

describe("PromptLoader with bundle workflows", () => {
  test("loads a bundle-contributed workflow by name", async () => {
    const v = await makeTestVault();
    try {
      const dir = join(v.path, ".dome", "extensions", "hello-world");
      await mkdir(join(dir, "workflows"), { recursive: true });
      await writeFile(join(dir, "manifest.yaml"), "name: hello-world\nversion: 1.0.0\n");
      await writeFile(
        join(dir, "workflows", "say-hello.md"),
        "---\ntools: [readDocument]\n---\nHello content.\n",
      );

      const vaultResult = await openVault(v.path);
      expect(vaultResult.ok).toBe(true);
      if (!vaultResult.ok) return;

      const loader = new PromptLoader(vaultResult.value);
      const prompt = await loader.load("say-hello");
      expect(prompt).toBeTruthy();
      expect(prompt?.body).toContain("Hello content");
      await vaultResult.value.close();
    } finally {
      await v.cleanup();
    }
  });

  test("list() includes bundle workflow names", async () => {
    const v = await makeTestVault();
    try {
      const dir = join(v.path, ".dome", "extensions", "hello-world");
      await mkdir(join(dir, "workflows"), { recursive: true });
      await writeFile(join(dir, "manifest.yaml"), "name: hello-world\nversion: 1.0.0\n");
      await writeFile(
        join(dir, "workflows", "say-hello.md"),
        "---\ntools: [readDocument]\n---\nbody\n",
      );

      const vaultResult = await openVault(v.path);
      expect(vaultResult.ok).toBe(true);
      if (!vaultResult.ok) return;

      const loader = new PromptLoader(vaultResult.value);
      const names = await loader.list();
      expect(names).toContain("say-hello");
      await vaultResult.value.close();
    } finally {
      await v.cleanup();
    }
  });
});
