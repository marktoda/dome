// AC3 lockstep slot for WORKFLOWS_KNOW_VAULT_CONTEXT (off-matrix; enforcement
// at the PromptLoader boundary per docs/wiki/matrices/tool-invariant-enforcement.md
// §"WORKFLOWS_KNOW_VAULT_CONTEXT — runner-enforced (off-matrix)").
//
// Main's c69f856 retired the SYSTEM_PREAMBLES code-driven registry and replaced
// it with SDK partials included via PromptLoader. Main's a9e6fc6 then split the
// preambles by scope:
//   - preamble-vault-identity.md  — UNIVERSAL: included from system-base.md
//   - preamble-rendering-surface.md — WORKFLOW-ONLY: included from each
//     workflow prompt (right after the system-base include)
//
// A workflow's resolved def.body contains BOTH preambles (via the chain
// system-base → vault-identity; workflow body → rendering-surface).
// MCP `instructions` and `dome.system_prompt` carry only vault-identity.
//
// This test pins the four properties WORKFLOWS_KNOW_VAULT_CONTEXT.md §"Test
// guarantee" promises against the workflow-resolution path:
//   (a) Vault-identity partial is included and contains vault.path (substituted).
//   (b) Rendering-surface partial is included and contains "non-interactive" + "cli".
//   (c) Composition order: vault-identity section appears BEFORE rendering-surface.
//   (d) PromptLoader substitutes {{vault.path}} so no literal template marker
//       remains in the resolved body.

import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { PromptLoader } from "../../src/prompts/prompt-loader";
import { makeTestVault } from "../helpers/make-test-vault";

describe("WORKFLOWS_KNOW_VAULT_CONTEXT (off-matrix lockstep)", () => {
  test("PromptLoader resolves a workflow body containing the vault-identity preamble naming vault.path", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const loader = new PromptLoader(res.value);
      // `ingest` includes system-base + rendering-surface; system-base
      // includes vault-identity. The chain delivers both preambles to a
      // workflow's resolved body.
      const prompt = await loader.load("ingest");
      expect(prompt).not.toBeNull();
      expect(prompt!.body).toContain("# Current vault");
      expect(prompt!.body).toContain(v.path);
    } finally {
      await v.cleanup();
    }
  });

  test("workflow body contains the rendering-surface preamble", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const loader = new PromptLoader(res.value);
      const prompt = await loader.load("ingest");
      expect(prompt!.body).toContain("# Rendering surface");
      expect(prompt!.body.toLowerCase()).toContain("non-interactive");
      expect(prompt!.body.toLowerCase()).toContain("cli");
    } finally {
      await v.cleanup();
    }
  });

  test("preamble order: vault-identity section appears before rendering-surface", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const loader = new PromptLoader(res.value);
      const prompt = await loader.load("ingest");
      const vaultIdentityIdx = prompt!.body.indexOf("# Current vault");
      const renderingSurfaceIdx = prompt!.body.indexOf("# Rendering surface");
      expect(vaultIdentityIdx).toBeGreaterThan(-1);
      expect(renderingSurfaceIdx).toBeGreaterThan(-1);
      expect(vaultIdentityIdx).toBeLessThan(renderingSurfaceIdx);
    } finally {
      await v.cleanup();
    }
  });

  test("PromptLoader substitutes {{vault.path}} so no literal template marker remains", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const loader = new PromptLoader(res.value);
      const prompt = await loader.load("ingest");
      // The substitution boundary is the PromptLoader. If a future regression
      // disabled it, this assertion fails before the LLM sees an unsubstituted
      // template marker.
      expect(prompt!.body).not.toContain("{{vault.path}}");
    } finally {
      await v.cleanup();
    }
  });
});
