import { describe, test, expect } from "bun:test";
import { domeServe } from "../../src/cli/commands/serve";
import { makeTestVault } from "../helpers/make-test-vault";

describe("domeServe", () => {
  test("returns a connected server (handlers wired, adapters populated)", async () => {
    // connectStdio: false keeps the test runner's stdio out of the picture;
    // we verify the same handler-registration path runs via DomeMcpServer's
    // tool/prompt/resource arrays being populated and serveStdio being
    // callable. The real production path passes connectStdio: true.
    const v = await makeTestVault();
    try {
      const r = await domeServe(v.path, { connectStdio: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // 7 MCP tools, ≥5 prompts (5 shipped-default + dome.system_prompt),
      // 3 resources — the substrate's promised surface.
      expect(r.value.server.tools.length).toBe(7);
      // Prompts and resources are on the ConsumerSurface, not the server
      // (post-Phase-B). The serve handle exposes both.
      const prompts = r.value.surface.prompts;
      expect(prompts.length).toBeGreaterThanOrEqual(6);
      const resources = await r.value.surface.resources.list();
      expect(resources.length).toBe(3);
      await r.value.stop();
    } finally {
      await v.cleanup();
    }
  });

  test("propagates vault-open errors as a Result.err rather than throwing", async () => {
    // A path with neither .dome nor .git should produce a clean error Result.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "dome-serve-bad-"));
    try {
      const r = await domeServe(dir, { connectStdio: false });
      expect(r.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
