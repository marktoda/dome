// Medium 9: workflow-driven CLI commands fail clean when ANTHROPIC_API_KEY
// is missing — they return a typed missing-api-key ToolError, not a raw
// AI_LoadAPIKeyError stack. The CLI renders the typed error as an
// actionable one-liner via renderToolError -> formatMissingApiKey.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAnthropicApiKey, formatMissingApiKey } from "../../src/cli/api-key-guard";
import { domeLint } from "../../src/cli/commands/lint";
import { domeExportContext } from "../../src/cli/commands/export-context";
import { domeMigrate } from "../../src/cli/commands/migrate";
import { domeInit } from "../../src/cli/commands/init";

// Save and restore the env var so tests don't bleed into each other.
const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
  }
});

describe("ANTHROPIC_API_KEY pre-flight", () => {
  test("checkAnthropicApiKey returns missing-api-key when env is unset", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const err = checkAnthropicApiKey();
    expect(err).not.toBeNull();
    expect(err!.kind).toBe("missing-api-key");
    expect(err!.env).toBe("ANTHROPIC_API_KEY");
  });

  test("checkAnthropicApiKey returns missing-api-key when env is empty string", () => {
    process.env.ANTHROPIC_API_KEY = "";
    const err = checkAnthropicApiKey();
    expect(err).not.toBeNull();
  });

  test("checkAnthropicApiKey returns null when env is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(checkAnthropicApiKey()).toBeNull();
  });

  test("formatMissingApiKey produces an actionable user message", () => {
    const msg = formatMissingApiKey({ kind: "missing-api-key", env: "ANTHROPIC_API_KEY" });
    expect(msg).toContain("ANTHROPIC_API_KEY");
    expect(msg).toContain("not set");
    expect(msg.toLowerCase()).toContain("export");
  });

  test("domeLint returns missing-api-key error when env is unset and no mock model", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const base = await mkdtemp(join(tmpdir(), "dome-lint-noapi-"));
    const vaultPath = join(base, "vault");
    try {
      await domeInit(vaultPath);
      const r = await domeLint(vaultPath);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("missing-api-key");
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("domeExportContext returns missing-api-key error when env is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const base = await mkdtemp(join(tmpdir(), "dome-export-noapi-"));
    const vaultPath = join(base, "vault");
    try {
      await domeInit(vaultPath);
      const r = await domeExportContext(vaultPath, "test topic");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("missing-api-key");
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("domeMigrate returns missing-api-key error when env is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const base = await mkdtemp(join(tmpdir(), "dome-migrate-noapi-"));
    try {
      // domeMigrate's pre-flight check fires before any filesystem work, so
      // we don't need a real directory.
      const r = await domeMigrate(base, false);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("missing-api-key");
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
