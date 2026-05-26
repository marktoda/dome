// MCP prompt adapter tests — adapted to the renderMcp(buildAbstractSurface(vault))
// chain after Phase D removed src/mcp/prompt-adapters.ts. The substrate-shape
// pins from main's a9e6fc6 (rendering-surface preamble is workflow-only, NOT
// in dome.system_prompt) survive against the new code path.

import { describe, test, expect } from "bun:test";
import { buildAbstractSurface } from "../../src/abstract-surface";
import { renderMcp } from "../../src/mcp/render-mcp";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("MCP prompt adapters (via renderMcp)", () => {
  test("exposes 5 shipped-default workflows + dome.system_prompt by default", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const surface = await buildAbstractSurface(res.value);
      const mcp = renderMcp(surface);
      // 5 shipped-default workflows + dome.system_prompt
      expect(mcp.prompts.length).toBe(6);
      expect(mcp.prompts.find(a => a.name === "dome.system_prompt")).toBeDefined();
      expect(mcp.prompts.find(a => a.name === "dome.workflow.ingest")).toBeDefined();
      expect(mcp.prompts.find(a => a.name === "dome.workflow.export_context")).toBeDefined();
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
      const surface = await buildAbstractSurface(res.value);
      const mcp = renderMcp(surface);
      const sysPrompt = mcp.prompts.find(a => a.name === "dome.system_prompt");
      expect(sysPrompt).toBeDefined();
      expect(sysPrompt!.body).toContain(v.path); // vault-identity present (substituted)
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
      const surface = await buildAbstractSurface(res.value);
      const mcp = renderMcp(surface);
      const ingest = mcp.prompts.find(a => a.name === "dome.workflow.ingest");
      expect(ingest).toBeDefined();
      expect(ingest!.body.toLowerCase()).toContain("non-interactive");
      expect(ingest!.body).toContain("# Rendering surface");
    } finally {
      await v.cleanup();
    }
  });
});
