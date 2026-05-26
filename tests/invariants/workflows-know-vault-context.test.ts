// AC3 lockstep slot for WORKFLOWS_KNOW_VAULT_CONTEXT (off-matrix; enforcement
// at the PromptLoader boundary per docs/wiki/matrices/tool-invariant-enforcement.md
// §"WORKFLOWS_KNOW_VAULT_CONTEXT — runner-enforced (off-matrix)").
//
// Main's c69f856 retired the SYSTEM_PREAMBLES code-driven registry and replaced
// it with two SDK partials (`preamble-vault-identity.md` + `preamble-rendering-surface.md`)
// included at the top of `system-base.md`. PromptLoader resolves the includes
// and substitutes `{{vault.path}}` with the actual vault path. The enforcement
// seam moved from the agent-loop runner to the PromptLoader boundary; the
// invariant intent is unchanged.
//
// This test pins the four properties WORKFLOWS_KNOW_VAULT_CONTEXT.md §"Test
// guarantee" promises:
//   (a) Vault-identity partial is included and contains vault.path (substituted).
//   (b) Rendering-surface partial is included and contains "non-interactive" + "cli".
//   (c) Composer order: vault-identity section appears BEFORE rendering-surface.
//   (d) PromptLoader's substitution actually fires — no literal `{{vault.path}}`
//       remains in the resolved body.

import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { PromptLoader } from "../../src/prompts/prompt-loader";
import { makeTestVault } from "../helpers/make-test-vault";

describe("WORKFLOWS_KNOW_VAULT_CONTEXT (off-matrix lockstep)", () => {
  test("PromptLoader resolves system-base to a body containing the vault-identity preamble naming vault.path", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const loader = new PromptLoader(res.value);
      const prompt = await loader.load("system-base");
      expect(prompt).not.toBeNull();
      expect(prompt!.body).toContain("# Current vault");
      expect(prompt!.body).toContain(v.path);
    } finally {
      await v.cleanup();
    }
  });

  test("system-base body contains the rendering-surface preamble", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const loader = new PromptLoader(res.value);
      const prompt = await loader.load("system-base");
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
      const prompt = await loader.load("system-base");
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
      const prompt = await loader.load("system-base");
      // The substitution boundary is the PromptLoader. If a future regression
      // disabled it, this assertion fails before the LLM sees an unsubstituted
      // template marker.
      expect(prompt!.body).not.toContain("{{vault.path}}");
    } finally {
      await v.cleanup();
    }
  });
});
