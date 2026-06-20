#!/usr/bin/env bun

/**
 * `bun run eval` — the Dome eval harness CLI.
 *
 * Runs `ALL_EVAL_CASES` through `runEvalSuite` with a hermetic env by default
 * (scripted model steps, no network), or a live Anthropic provider with
 * `--live` (requires ANTHROPIC_API_KEY, throws loudly without it).
 *
 * The hermetic env is built from `BRIEF_BASIC_SCRIPT` — the same script
 * the brief case's unit test uses — so the CLI drives the brief case through
 * an identical path. The brief case internally gates the provider so that only
 * the brief-charter agent receives the scripted steps; every other scheduled
 * processor gets a terminal no-op.
 *
 * Usage:
 *   bun run eval          # hermetic (default, no key needed)
 *   bun run eval --live   # live Anthropic provider (ANTHROPIC_API_KEY required)
 *
 * Exit codes:
 *   0 — all cases passed
 *   1 — one or more cases failed (or the run threw)
 */

import { hermeticEvalEnv, liveEvalEnv } from "../src/eval/provider";
import { runEvalSuite } from "../src/eval/run-suite";
import { ALL_EVAL_CASES } from "../src/eval/cases/index";
import { BRIEF_BASIC_SCRIPT } from "../tests/fixtures/eval/brief-basic/script";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isLive = args.includes("--live");

  const { env } = isLive
    ? liveEvalEnv()
    : hermeticEvalEnv(BRIEF_BASIC_SCRIPT);

  const mode = isLive ? "live" : "hermetic";
  console.log(`eval: running ${ALL_EVAL_CASES.length} case(s) [${mode}]`);

  const report = await runEvalSuite(ALL_EVAL_CASES, {
    env,
    log: (line) => console.log(line),
  });

  console.log(
    `\neval: ${report.passed} passed, ${report.failed} failed`,
  );

  process.exit(report.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`eval: ${message}`);
  process.exit(1);
});
