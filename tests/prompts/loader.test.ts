import { describe, test, expect } from "bun:test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PromptLoader } from "../../src/prompts/prompt-loader";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("PromptLoader", () => {
  test("loads a builtin prompt by name", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const loader = new PromptLoader(res.value);
      const p = await loader.load("ingest");
      expect(p).not.toBeNull();
      expect(p!.body).toContain("ingest"); // builtin describes itself
    } finally {
      await v.cleanup();
    }
  });

  test("vault-local override wins over builtin", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "prompts"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "prompts", "ingest.md"),
        `---
type: workflow-prompt
name: ingest
tools: [readDocument]
triggers: []
---

# CUSTOM INGEST PROMPT
`
      );
      const res = await openVault(v.path);
      if (!res.ok) return;
      const loader = new PromptLoader(res.value);
      const p = await loader.load("ingest");
      expect(p).not.toBeNull();
      expect(p!.body).toContain("CUSTOM INGEST PROMPT");
      expect(p!.source).toBe("vault-local");
    } finally {
      await v.cleanup();
    }
  });

  test("returns null for unknown name", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const loader = new PromptLoader(res.value);
      const p = await loader.load("nonexistent");
      expect(p).toBeNull();
    } finally {
      await v.cleanup();
    }
  });

  test("resolves {{include: system-base.md}}", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "prompts"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "prompts", "custom.md"),
        `# Custom

{{include: system-base.md}}

End.`
      );
      const res = await openVault(v.path);
      if (!res.ok) return;
      const loader = new PromptLoader(res.value);
      const p = await loader.load("custom");
      expect(p).not.toBeNull();
      // system-base should be inlined
      expect(p!.body).not.toContain("{{include:");
      expect(p!.body).toContain("End.");
    } finally {
      await v.cleanup();
    }
  });
});
