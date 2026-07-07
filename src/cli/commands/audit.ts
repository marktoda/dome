// cli/commands/audit: the vault-consistency audit umbrella.
//
// `dome audit <subject>` collects the single-purpose read-only consistency
// audits under one verb (cohesion review 2026-07-06): `stale-claims`
// (dome.claims.stale-claims) and `orphan-pages` (dome.markdown.orphan-pages)
// were previously two top-level nouns shelved under "recall", but they are
// audits — lint-family instruments, not context views. Each subject
// delegates to its existing named-view wrapper; the view processors are
// unchanged.

import { runStaleClaims } from "./stale-claims";
import { runOrphanPages } from "./orphan-pages";
import { printViewCommandError } from "./view-shared";
import { EX_USAGE } from "../exit-codes";

export const AUDIT_SUBJECTS = Object.freeze([
  "stale-claims",
  "orphan-pages",
] as const);

export type AuditCommandOptions = {
  readonly json?: boolean | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
};

export async function runAudit(
  input: { readonly subject: string } & AuditCommandOptions,
): Promise<number> {
  const options: AuditCommandOptions = {
    json: input.json,
    vault: input.vault,
    bundlesRoot: input.bundlesRoot,
  };
  switch (input.subject) {
    case "stale-claims":
      return runStaleClaims(options);
    case "orphan-pages":
      return runOrphanPages(options);
    default:
      printViewCommandError({
        commandLabel: "dome audit",
        json: input.json === true,
        error: "audit-usage",
        messages: [
          `dome audit: unknown subject '${input.subject}'. Subjects: ${
            AUDIT_SUBJECTS.join(", ")
          }.`,
        ],
      });
      return EX_USAGE;
  }
}
