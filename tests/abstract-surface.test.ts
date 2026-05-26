// Pins the AbstractSurface contract per docs/wiki/specs/sdk-surface.md
// §"Consumer surfaces" §"AbstractSurface (in @dome/sdk core)":
//
//   - buildAbstractSurface(vault): Promise<AbstractSurface>
//   - tools is the same BoundToolSurface vault.tools exposes (identity check)
//   - prompts is a list of PromptDescriptor records (protocol-agnostic; no
//     dome.workflow.* prefix at this layer)
//   - resources is a list of ResourceDescriptor records (bare URIs; no
//     dome:// prefix at this layer)
//   - instructions is a string (the cold-start orientation text)

import { describe, test, expect } from "bun:test";
import { openVault } from "../src/vault";
import { buildAbstractSurface } from "../src/abstract-surface";
import { makeTestVault } from "./helpers/make-test-vault";

describe("buildAbstractSurface", () => {
  test("returns { tools, prompts, resources, instructions }", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const vault = res.value;

      const surface = await buildAbstractSurface(vault);

      // tools IS vault.tools — the protocol-agnostic BoundToolSurface
      expect(surface.tools).toBe(vault.tools);

      // prompts: list of descriptors with bare names (no dome.workflow.* prefix)
      expect(Array.isArray(surface.prompts)).toBe(true);
      expect(surface.prompts.length).toBeGreaterThan(0);
      for (const p of surface.prompts) {
        expect(typeof p.name).toBe("string");
        expect(p.name.startsWith("dome.")).toBe(false);
        expect(typeof p.body).toBe("string");
      }

      // resources: list of descriptors with bare URIs (no dome:// prefix)
      expect(Array.isArray(surface.resources)).toBe(true);
      expect(surface.resources.length).toBeGreaterThan(0);
      for (const r of surface.resources) {
        expect(typeof r.uri).toBe("string");
        expect(r.uri.startsWith("dome://")).toBe(false);
      }

      // instructions: non-empty string
      expect(typeof surface.instructions).toBe("string");
      expect(surface.instructions.length).toBeGreaterThan(0);
    } finally {
      await v.cleanup();
    }
  });

  test("does not statically import @ai-sdk/anthropic, ai, or @modelcontextprotocol/sdk", async () => {
    // This is a structural invariant — buildAbstractSurface lives in core.
    // The bundle-deps.test.ts already enforces this for src/index.ts
    // transitively; we add a direct check here so a future contributor
    // adding e.g. ai-sdk imports to abstract-surface.ts fails fast.
    const src = await Bun.file(
      new URL("../src/abstract-surface.ts", import.meta.url).pathname,
    ).text();
    expect(src).not.toMatch(/from\s+["']ai["']/);
    expect(src).not.toMatch(/from\s+["']@ai-sdk\//);
    expect(src).not.toMatch(/from\s+["']@modelcontextprotocol\//);
  });
});
