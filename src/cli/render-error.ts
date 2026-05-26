// CLI error renderer. Promoted to a public surface so other consumer shells
// (a future Electron/web/voice shell) can reuse the same one-line stderr
// format for the common error kinds without duplicating the switch.
//
// The renderer is intentionally a *consumer* concern: different shells may
// want different surfaces (JSON, structured terminal output, native dialogs).
// This module is the CLI's choice; consumers can swap in their own.

import type { CliError } from "./cli-error";
import { formatMissingApiKey } from "./api-key-guard";

/**
 * Render a CliError as a one-line stderr message. Special-cases the kinds a
 * shell user is most likely to encounter (`missing-api-key`,
 * `vault-not-git-repo`, `config-invalid`, `already-exists`, `not-found`,
 * `validation`); everything else falls back to JSON so the structured shape
 * is still visible.
 */
export function renderCliError(error: CliError): string {
  if (error.kind === "missing-api-key") return formatMissingApiKey(error);
  if (error.kind === "vault-not-git-repo") {
    return `Not a git repository: ${error.path}. Run 'git init' or use 'dome migrate' on an existing markdown vault.`;
  }
  if (error.kind === "config-invalid") {
    return `Vault config error: ${error.message}. Is this a Dome vault? Run 'dome init <path>' to bootstrap.`;
  }
  if (error.kind === "already-exists") {
    return `Already exists: ${error.path}`;
  }
  if (error.kind === "not-found") {
    return `Not found: ${error.path}`;
  }
  if (error.kind === "validation") return error.message;
  // Fall back to JSON for the less-common, more-structured kinds (invariant
  // violations, concurrent-write-conflict, dispatcher-owned-path, …) so the
  // user can see the full payload.
  return JSON.stringify(error);
}
