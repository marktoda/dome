// cli/args: tiny, hand-rolled argv parser for the Phase 9 CLI.
//
// The v1 CLI takes a single subcommand and a mix of positional + flag
// arguments per [[wiki/specs/cli]]. No nested subcommands; no aliases;
// every flag is either boolean (`--foo`) or single-valued (`--foo=bar`
// or `--foo bar`). Hand-rolled because the four Phase 9 commands fit
// in ~50 lines of parser; an external library (commander/yargs/sade)
// would be over-spec for the surface area.
//
// House-style notes:
//   - `type X = { ... }` aliases, every field `readonly`.
//   - The returned shape is frozen so a misbehaving command handler can't
//     mutate it mid-flight.
//   - Flag values are stored as `string | boolean`. Boolean flags
//     (`--foo`) carry `true`; single-valued flags carry the string.

// ----- Public types ---------------------------------------------------------

/**
 * The shape returned by `parseArgs`. Discriminators:
 *
 *   - `command`: the first positional. The empty string if no positional was
 *     supplied (the caller surfaces "no command" as a usage error).
 *   - `positionals`: remaining positionals after `command`.
 *   - `flags`: parsed `--flag` / `--flag=value` / `--flag value` pairs.
 */
export type ParsedArgs = {
  readonly command: string;
  readonly positionals: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, string | boolean>>;
};

// ----- parseArgs ------------------------------------------------------------

/**
 * Parse a raw argv slice (typically `process.argv.slice(2)`) into a
 * `ParsedArgs`. Recognized shapes:
 *
 *   - `cmd`                  → command="cmd", positionals=[], flags={}
 *   - `cmd foo bar`          → command="cmd", positionals=["foo","bar"]
 *   - `cmd --flag`           → flags={flag:true}
 *   - `cmd --flag=value`     → flags={flag:"value"}
 *   - `cmd --flag value`     → flags={flag:"value"} (separate-token form)
 *   - `cmd --flag --other`   → flags={flag:true, other:true}
 *
 * Unknown / malformed shapes (`-x`, `--`, empty `--`) flow through as
 * positionals — the caller's command handler decides whether to reject.
 * This parser does not enforce per-command flag schemas; that's the
 * command handler's job.
 */
export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) {
      i++;
      continue;
    }

    if (tok.startsWith("--") && tok.length > 2) {
      const body = tok.slice(2);
      const eqIdx = body.indexOf("=");
      if (eqIdx >= 0) {
        // `--flag=value` form. An empty value (e.g., `--flag=`) lands as "".
        const name = body.slice(0, eqIdx);
        const value = body.slice(eqIdx + 1);
        if (name.length > 0) flags[name] = value;
      } else {
        // `--flag` or `--flag value`. Peek at the next token: if it exists
        // and isn't itself a flag, consume it as the value.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else {
      positionals.push(tok);
    }
    i++;
  }

  const command = positionals.length > 0 ? (positionals[0] ?? "") : "";
  const rest = positionals.slice(1);

  return Object.freeze({
    command,
    positionals: Object.freeze(rest),
    flags: Object.freeze(flags),
  });
}
