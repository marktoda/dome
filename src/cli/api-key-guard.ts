// Pre-flight check for ANTHROPIC_API_KEY. Workflow-driven CLI commands
// (lint, migrate, export-context) shell out to runWorkflow which calls
// generateText via @ai-sdk/anthropic; without the key the SDK throws a
// generic AI_LoadAPIKeyError that surfaces to the user as opaque JSON.
//
// Returning a typed ToolError gives the CLI a clean Failure with an
// actionable message ("set ANTHROPIC_API_KEY=...") instead of a stack.

import type { ToolError } from "../types";

const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * Returns a typed missing-api-key ToolError if ANTHROPIC_API_KEY is unset or
 * empty. Returns null when the env var is set (the caller proceeds to
 * runWorkflow which validates the key shape and 401s against the API for
 * malformed keys — out of scope for the pre-flight).
 */
export function checkAnthropicApiKey(): Extract<ToolError, { kind: "missing-api-key" }> | null {
  const key = process.env[ANTHROPIC_API_KEY_ENV];
  if (key === undefined || key.length === 0) {
    return { kind: "missing-api-key", env: ANTHROPIC_API_KEY_ENV };
  }
  return null;
}

/**
 * Render a missing-api-key error as a one-line actionable message for the
 * CLI to print to stderr.
 */
export function formatMissingApiKey(error: Extract<ToolError, { kind: "missing-api-key" }>): string {
  return `${error.env} is not set. This command runs an LLM workflow; export ${error.env}=sk-... before retrying. See https://console.anthropic.com/settings/keys for a key.`;
}
