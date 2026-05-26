import { describe, test, expect } from "bun:test";
import { buildPromptAdapters } from "../../src/mcp/prompt-adapters";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("MCP prompt adapters", () => {
  test("exposes 5 shipped-default workflows by default", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const adapters = await buildPromptAdapters(res.value);
      // 5 shipped-default workflows
      expect(adapters.length).toBe(5);
      expect(adapters.find(a => a.name === "dome.workflow.ingest")).toBeDefined();
      expect(adapters.find(a => a.name === "dome.workflow.export_context")).toBeDefined();
    } finally {
      await v.cleanup();
    }
  });

  test("excludes sensitivity-classify (sub-workflow, not standalone)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const adapters = await buildPromptAdapters(res.value);
      expect(adapters.find(a => a.name === "dome.workflow.sensitivity_classify")).toBeUndefined();
    } finally {
      await v.cleanup();
    }
  });
});
