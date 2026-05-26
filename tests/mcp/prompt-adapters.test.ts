import { describe, test, expect } from "bun:test";
import { buildPromptAdapters } from "../../src/mcp/prompt-adapters";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("MCP prompt adapters", () => {
  test("exposes 5 shipped-default workflows + dome.system_prompt by default", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const adapters = await buildPromptAdapters(res.value);
      // 5 shipped-default workflows + dome.system_prompt
      expect(adapters.length).toBe(6);
      expect(adapters.find(a => a.name === "dome.system_prompt")).toBeDefined();
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

  // dome.system_prompt is the interactive-session orientation prompt the
  // harness loads at session start. dome.workflow.* are the non-interactive
  // workflow prompts. The rendering-surface preamble belongs only on the
  // workflow side; pinning the split here prevents `system-base.md` from
  // silently regaining the workflow-only preamble.
  test("dome.system_prompt carries vault-identity but NOT the workflow-only rendering-surface", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const adapters = await buildPromptAdapters(res.value);
      const sysPrompt = adapters.find(a => a.name === "dome.system_prompt");
      expect(sysPrompt).toBeDefined();
      expect(sysPrompt!.body).toContain(v.path); // vault-identity present
      expect(sysPrompt!.body.toLowerCase()).not.toContain("non-interactive"); // rendering-surface absent
      expect(sysPrompt!.body).not.toContain("# Rendering surface");
    } finally {
      await v.cleanup();
    }
  });

  test("dome.workflow.* prompts DO carry the rendering-surface preamble (non-interactive context)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const adapters = await buildPromptAdapters(res.value);
      const ingest = adapters.find(a => a.name === "dome.workflow.ingest");
      expect(ingest).toBeDefined();
      expect(ingest!.body.toLowerCase()).toContain("non-interactive");
      expect(ingest!.body).toContain("# Rendering surface");
    } finally {
      await v.cleanup();
    }
  });
});
