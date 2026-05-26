// AC3 lockstep slot for WORKFLOWS_KNOW_VAULT_CONTEXT (off-matrix; runner-enforced
// per docs/wiki/matrices/tool-invariant-enforcement.md §"WORKFLOWS_KNOW_VAULT_CONTEXT
// — runner-enforced (off-matrix)"). Pins the composer's contract:
//
//   (a) Vault-identity preamble appears in the composed output and contains vault.path.
//   (b) Rendering-surface preamble appears and contains "non-interactive" + "cli".
//   (c) Composer order: vault-identity section ("# Current vault") appears
//       BEFORE the rendering-surface section ("# Rendering surface").
//   (d) Empty-output drop: a preamble returning "" does not introduce a blank section.
//
// (a) and (b) are also pinned by tests/workflows/agent-loop.test.ts via the
// runWorkflow path; this file pins them directly against buildSystemPreamble
// and adds (c) and (d) per the pass-2 architecture-review F1 closure.

import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { buildSystemPreamble } from "../../src/workflows/agent-loop";
import { makeTestVault } from "../helpers/make-test-vault";

describe("WORKFLOWS_KNOW_VAULT_CONTEXT (off-matrix lockstep)", () => {
  test("buildSystemPreamble includes a vault-identity section naming vault.path", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const composed = buildSystemPreamble(res.value);
      expect(composed).toContain("# Current vault");
      expect(composed).toContain(v.path);
    } finally {
      await v.cleanup();
    }
  });

  test("buildSystemPreamble includes a rendering-surface section", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const composed = buildSystemPreamble(res.value);
      expect(composed).toContain("# Rendering surface");
      expect(composed.toLowerCase()).toContain("non-interactive");
      expect(composed.toLowerCase()).toContain("cli");
    } finally {
      await v.cleanup();
    }
  });

  test("buildSystemPreamble preamble order: vault-identity before rendering-surface", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const composed = buildSystemPreamble(res.value);
      const vaultIdentityIdx = composed.indexOf("# Current vault");
      const renderingSurfaceIdx = composed.indexOf("# Rendering surface");
      expect(vaultIdentityIdx).toBeGreaterThan(-1);
      expect(renderingSurfaceIdx).toBeGreaterThan(-1);
      expect(vaultIdentityIdx).toBeLessThan(renderingSurfaceIdx);
    } finally {
      await v.cleanup();
    }
  });

  test("buildSystemPreamble drops preambles that return empty strings (no triple-blank-line gap)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const composed = buildSystemPreamble(res.value);
      // Sections join with "\n\n" — exactly one blank line. Three or more
      // consecutive newlines indicate an empty-output preamble snuck in.
      expect(composed).not.toMatch(/\n\n\n/);
    } finally {
      await v.cleanup();
    }
  });
});
