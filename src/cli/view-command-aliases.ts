// CLI invocations for dedicated wrappers around view processors.
//
// Most view processors use the same command trigger the user runs through the
// CLI. Keep that mapping centralized so tests and loop metadata do not leak
// internal trigger names into user-facing status surfaces. Since the
// 2026-07-06 cohesion review an alias is an invocation, not necessarily a
// top-level verb: the daily framings are flags of `today` and the
// consistency audits are subjects of `dome audit` (the bound top-level
// command is the invocation's first word).

export const DEDICATED_VIEW_COMMAND_ALIASES: ReadonlyMap<string, string> =
  Object.freeze(
    new Map<string, string>([
      ["agenda-with", "today --with"],
      ["export-context", "export-context"],
      ["lint", "lint"],
      ["orphan-pages", "audit orphan-pages"],
      ["prep", "today --prep"],
      ["query", "query"],
      ["stale-claims", "audit stale-claims"],
    ]),
  );

export function publicViewCommandName(commandTriggerName: string): string {
  return DEDICATED_VIEW_COMMAND_ALIASES.get(commandTriggerName) ??
    commandTriggerName;
}
