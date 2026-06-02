// Public CLI command names for dedicated wrappers around view processors.
//
// Most view processors use the same command trigger the user runs through the
// CLI. A few keep a more precise internal trigger name while exposing a simpler
// public command. Keep that mapping centralized so tests and loop metadata do
// not leak internal trigger names into user-facing status surfaces.

export const DEDICATED_VIEW_COMMAND_ALIASES: ReadonlyMap<string, string> =
  Object.freeze(
    new Map<string, string>([
      ["agenda-with", "agenda"],
      ["export-context", "export-context"],
      ["lint", "lint"],
      ["prep", "prep"],
      ["query", "query"],
      ["today", "today"],
    ]),
  );

export function publicViewCommandName(commandTriggerName: string): string {
  return DEDICATED_VIEW_COMMAND_ALIASES.get(commandTriggerName) ??
    commandTriggerName;
}
