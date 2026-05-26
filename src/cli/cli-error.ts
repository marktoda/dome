// CLI-layer error union.
//
// The SDK's core `ToolError` enumerates failures that the seven Tools and
// `openVault` can produce. The CLI shell has its own pre-flight failures
// (currently just `missing-api-key`) that aren't part of any Tool's
// contract — they're a property of running LLM-driven CLI commands. Keeping
// them out of core `ToolError` preserves the SDK / consumer-shell boundary:
// a future mobile or web shell that doesn't shell out to env vars won't
// ship this error kind it can't produce.

import type { ToolError } from "../types";

/** Pre-flight failure raised by the CLI before invoking an LLM workflow. */
export interface MissingApiKeyError {
  kind: "missing-api-key";
  env: string;
}

/** Errors a CLI command can return: any `ToolError` plus CLI-shell pre-flights. */
export type CliError = ToolError | MissingApiKeyError;
