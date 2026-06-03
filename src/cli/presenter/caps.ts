// src/cli/presenter/caps.ts
//
// The single environment read for CLI human output. Every presenter
// primitive is a pure function of the returned Caps — no primitive reads
// process.env or process.stdout directly. Tests inject Caps to assert
// exact output.

export type Caps = {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly width: number;
};

type OutStream = { readonly isTTY?: boolean; readonly columns?: number };

const DEFAULT_WIDTH = 80;

function isForceColor(env: Record<string, string | undefined>): boolean {
  const v = env.FORCE_COLOR;
  return v !== undefined && v.length > 0 && v !== "0" && v.toLowerCase() !== "false";
}

function isUtfLocale(env: Record<string, string | undefined>): boolean {
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
  return /utf-?8/i.test(locale);
}

/**
 * Resolve output capabilities from a stream + environment. `--json` callers
 * never reach this — they serialize and return before rendering.
 *
 * Precedence for color: NO_COLOR (off) > FORCE_COLOR (on) > stream.isTTY.
 */
export function resolveCaps(
  stream: OutStream = process.stdout,
  env: Record<string, string | undefined> = process.env,
): Caps {
  const color =
    env.NO_COLOR !== undefined ? false : isForceColor(env) ? true : stream.isTTY === true;
  const unicode = stream.isTTY === true && isUtfLocale(env);
  const width =
    typeof stream.columns === "number" && stream.columns > 0 ? stream.columns : DEFAULT_WIDTH;
  return { color, unicode, width };
}
