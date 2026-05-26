import { describe, test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildInstructions } from "../../src/mcp/instructions-builder";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("buildInstructions", () => {
  test("includes system-base content", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const out = await buildInstructions(res.value);
      // system-base.md opens with this heading; if it ever changes the test
      // will catch it and we update both intentionally.
      expect(out).toContain("# Dome — Wiki Maintainer");
      expect(out).toContain("RAW_IS_IMMUTABLE");
    } finally {
      await v.cleanup();
    }
  });

  test("lists enabled invariants but omits disabled ones", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const out = await buildInstructions(res.value);
      // Default config: EVERY_WRITE_IS_LOGGED=enabled, SENSITIVE_GOES_TO_INBOX=disabled.
      expect(out).toContain("### Enabled invariants");
      expect(out).toContain("- EVERY_WRITE_IS_LOGGED");
      expect(out).not.toContain("- SENSITIVE_GOES_TO_INBOX");
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
      const out = await buildInstructions(res.value);
      expect(out).toContain("### Page types");
      expect(out).toContain("- entity");
      expect(out).toContain("- synthesis");
      expect(out).toContain("- decision");
      expect(out).toContain("- meeting");
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
      const out = await buildInstructions(res.value);
      expect(out).toContain("### Vault notes (from AGENTS.md)");
      expect(out).toContain("Project Foo");
    } finally {
      await v.cleanup();
    }
  });

  test("falls back gracefully when AGENTS.md is absent", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const out = await buildInstructions(res.value);
      expect(out).toContain("### Vault notes (from AGENTS.md)");
      expect(out).toContain("_No AGENTS.md present._");
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
      const out = await buildInstructions(res.value);
      expect(out.toLowerCase()).not.toContain("non-interactive");
      expect(out).not.toContain("# Rendering surface");
      // Vault identity SHOULD be present — universal across surfaces.
      expect(out).toContain(v.path);
    } finally {
      await v.cleanup();
    }
  });
});
