// Structural fence: the test suite is hermetic against live LLM credentials.
//
// Bun auto-loads the repo-root `.env` (which carries a real ANTHROPIC_API_KEY
// on dev machines) into every `bun test` process, and Bun.spawn inherits it
// into child `dome` processes — so any test that syncs a vault wired to the
// shipped anthropic provider template would silently make REAL API calls
// (cost, latency, flakiness). That is exactly how the v1-dogfood-preflight
// serve-readiness tests failed for two days while spending ~$0.09/run.
//
// `tests/preload.ts` (wired via bunfig.toml `[test].preload`) blanks the key
// and points the base URL at an unroutable address for the whole suite. An
// explicitly-empty env var wins over `.env` in this process and in spawned
// bun children, so a residual live-model path fails loudly (key-missing run
// failure) instead of silently spending money.
//
// Tests that need provider behavior keep working: they inject scripted
// command providers (tests/cli/commands/doctor.test.ts fixtures,
// v1-dogfood-preflight's stub) or build child env explicitly with their own
// overrides last (tests/assets/anthropic-model-provider.test.ts). The
// opt-in REAL smoke path lives outside `bun test` (scripts/v1-llm-smoke.ts).

import { describe, expect, test } from "bun:test";

describe("hermetic test environment (preload fence)", () => {
  test("ANTHROPIC_API_KEY is explicitly blank, beating .env in children", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBe("");
  });

  test("ANTHROPIC_BASE_URL is unroutable", () => {
    expect(process.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
  });
});
