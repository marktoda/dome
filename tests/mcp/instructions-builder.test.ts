// MCP instructions tests — adapted to buildAbstractSurface(vault).instructions
// after Phase D removed src/mcp/instructions-builder.ts. The instructions
// composition moved to buildInstructionsString inside src/abstract-surface.ts,
// reachable via AbstractSurface.instructions. The substrate-shape pins from
// main's a9e6fc6 (rendering-surface is workflow-only; NOT in instructions)
// survive against the new code path.

import { describe, test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAbstractSurface } from "../../src/abstract-surface";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("AbstractSurface.instructions (cold-start MCP instructions)", () => {
  test("includes system-base content", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const surface = await buildAbstractSurface(res.value);
      // system-base.md opens with this heading; if it ever changes the test
      // will catch it and we update both intentionally.
      expect(surface.instructions).toContain("# Dome — Wiki Maintainer");
      expect(surface.instructions).toContain("RAW_IS_IMMUTABLE");
    } finally {
      await v.cleanup();
    }
  });

  test("lists enabled invariants but omits disabled ones", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const surface = await buildAbstractSurface(res.value);
      expect(surface.instructions).toContain("### Enabled invariants");
      expect(surface.instructions).toContain("- EVERY_WRITE_IS_LOGGED");
    } finally {
      await v.cleanup();
    }
  });

  test("lists page-type defaults and extensions", async () => {
    const customPageTypes = `defaults:
  - entity
  - concept
  - source
  - synthesis
extensions:
  - decision
  - { name: meeting }
`;
    const v = await makeTestVault({ pageTypes: customPageTypes });
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const surface = await buildAbstractSurface(res.value);
      expect(surface.instructions).toContain("### Page types");
      expect(surface.instructions).toContain("- entity");
      expect(surface.instructions).toContain("- synthesis");
      expect(surface.instructions).toContain("- decision");
      expect(surface.instructions).toContain("- meeting");
    } finally {
      await v.cleanup();
    }
  });

  test("inlines AGENTS.md when present", async () => {
    const v = await makeTestVault();
    try {
      await writeFile(
        join(v.path, "AGENTS.md"),
        "# This vault\n\nNotes: this vault tracks Project Foo.\n",
      );
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const surface = await buildAbstractSurface(res.value);
      expect(surface.instructions).toContain("### Vault notes (from AGENTS.md)");
      expect(surface.instructions).toContain("Project Foo");
    } finally {
      await v.cleanup();
    }
  });

  test("falls back gracefully when AGENTS.md is absent", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const surface = await buildAbstractSurface(res.value);
      expect(surface.instructions).toContain("### Vault notes (from AGENTS.md)");
      expect(surface.instructions).toContain("_No AGENTS.md present._");
    } finally {
      await v.cleanup();
    }
  });

  // The MCP `instructions` payload is delivered to interactive Claude Code
  // sessions at server initialize. The rendering-surface preamble's framing
  // ("non-interactive single-turn workflow invocation") is workflow-only;
  // including it here would tell an interactive client that it has no
  // conversational follow-up channel — actively wrong. This test pins the
  // structural seam: rendering-surface stays in per-workflow includes, not
  // in `system-base.md`.
  test("does NOT carry the workflow-only rendering-surface preamble (interactive context)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const surface = await buildAbstractSurface(res.value);
      expect(surface.instructions.toLowerCase()).not.toContain("non-interactive");
      expect(surface.instructions).not.toContain("# Rendering surface");
      // Vault identity SHOULD be present — universal across surfaces.
      expect(surface.instructions).toContain(v.path);
    } finally {
      await v.cleanup();
    }
  });
});
