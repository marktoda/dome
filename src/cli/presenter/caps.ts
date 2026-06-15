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
  /** Terminal supports OSC 8 hyperlinks. Independent of `color`, like `unicode`. */
  readonly hyperlinks?: boolean;
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

function supportsHyperlinks(
  stream: OutStream,
  env: Record<string, string | undefined>,
): boolean {
  const force = env.DOME_HYPERLINKS ?? env.FORCE_HYPERLINK;
  if (force !== undefined) {
    return force.length > 0 && force !== "0" && force.toLowerCase() !== "false";
  }
  if (stream.isTTY !== true) return false;
  const prog = env.TERM_PROGRAM ?? "";
  if (prog === "iTerm.app" || prog === "WezTerm" || prog === "ghostty" || prog === "vscode") {
    return true;
  }
  if (/kitty/i.test(env.TERM ?? "")) return true;
  if (env.WT_SESSION !== undefined) return true; // Windows Terminal
  return false;
}

/**
 * Resolve output capabilities from a stream + environment. `--json` callers
 * never reach this — they serialize and return before rendering.
 *
 * Precedence for color: NO_COLOR (off) > FORCE_COLOR (on) > stream.isTTY.
 * Note: `unicode` is intentionally independent of `color`; a NO_COLOR terminal
 * with a UTF locale still gets `unicode: true` so glyphs render as `✓` rather
 * than the ASCII `√` fallback even when color is disabled.
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
  return { color, unicode, width, hyperlinks: supportsHyperlinks(stream, env) };
}
