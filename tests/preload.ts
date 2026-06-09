// bun test preload (wired via bunfig.toml `[test].preload`): make the suite
// hermetic against live LLM credentials BEFORE any test file loads.
//
// Bun auto-loads the repo-root `.env` (real ANTHROPIC_API_KEY on dev
// machines) into this process, and Bun.spawn inherits env into child `dome`
// processes. Setting the key to an explicit empty string wins over `.env`
// here AND in spawned bun children (Bun never overrides an existing env
// var, empty included), so no test can reach the real Anthropic API; the
// unroutable base URL is the second, independent barrier. Pinned by
// tests/integration/hermetic-test-env.test.ts.
//
// Tests that need provider behavior inject scripted command providers or
// build child env explicitly with their own overrides last; the opt-in
// REAL smoke path lives outside `bun test` (scripts/v1-llm-smoke.ts).

process.env.ANTHROPIC_API_KEY = "";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
