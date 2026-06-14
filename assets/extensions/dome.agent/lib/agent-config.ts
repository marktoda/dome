// dome.agent shared config resolution.
//
// The nightly garden agents (sweep, consolidate) each read a small,
// identically-shaped slice of extension config: a ledger path, optional
// positive-integer knobs, and a list of in-scope target prefixes validated
// against the processor's own patch.auto write grant. These resolvers were
// near-verbatim copies in processors/sweep.ts and processors/consolidate.ts;
// they live here as one source of truth so the validation rules, fallback
// behavior, and `problem`-message shape can never drift between agents.
//
// Every resolver follows the same contract: a malformed config value never
// throws — it falls back to the supplied default and returns a non-null
// `problem` string the caller surfaces as a `*-config-invalid` warning
// diagnostic. Grants are static globs, so config can never widen a
// processor's write boundary.
//
// This file lives under `assets/` (excluded from the root tsconfig). Imports
// use relative paths into `src/`, resolved at runtime by Bun's loader.

import { validateRelativeMarkdownPath } from "../../../../src/core/config-path";
import { globMatch } from "../../../../src/engine/core/glob-cache";

export type LedgerResolution = {
  readonly path: string;
  /** Non-null when a malformed config value was ignored for the default. */
  readonly problem: string | null;
};

/**
 * Resolve a ledger path from `extensions.dome.agent.config[key]`, defaulting
 * to `defaultPath`. The value must be a relative vault `.md` path; a malformed
 * value falls back to the default with a `problem` the caller emits as a
 * warning. A custom path additionally requires matching `read` + `patch.auto`
 * grant entries in `.dome/config.yaml`.
 */
export function resolveLedgerPath(
  config: Readonly<Record<string, unknown>> | undefined,
  key: string,
  defaultPath: string,
): LedgerResolution {
  const raw = config?.[key];
  if (raw === undefined) return Object.freeze({ path: defaultPath, problem: null });
  const v = validateRelativeMarkdownPath(raw, key);
  if (!v.ok) {
    return Object.freeze({
      path: defaultPath,
      problem: `dome.agent config ${v.problem}; falling back to ${defaultPath}`,
    });
  }
  return Object.freeze({ path: v.path, problem: null });
}

export type NumberResolution = {
  readonly value: number;
  readonly problem: string | null;
};

/**
 * Resolve a positive-integer config knob, defaulting to `fallback`. Non-integer
 * / non-positive values degrade to the fallback with a `problem`.
 */
export function positiveIntConfig(
  config: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: number,
): NumberResolution {
  const raw = config?.[key];
  if (raw === undefined) return Object.freeze({ value: fallback, problem: null });
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return Object.freeze({
      value: fallback,
      problem: `dome.agent config ${key} must be a positive integer; falling back to ${fallback}`,
    });
  }
  return Object.freeze({ value: raw, problem: null });
}

export type TargetsResolution = {
  readonly value: ReadonlyArray<string>;
  readonly problem: string | null;
};

// A representative `.md` filename appended to each prefix to probe grant
// coverage. The content is irrelevant — `**` matches zero or more path
// segments, so coverage of any `.md` under the prefix implies coverage of all.
const GRANT_PROBE = "__grant-probe__.md";

/**
 * Resolve a list of in-scope target path prefixes from config[key], defaulting
 * to `defaultTargets`. Validates shape (non-empty array of clean relative
 * prefixes — no leading slash, backslash, or `..`) and grant coverage: every
 * prefix must be covered by `grantPatterns` (the processor's patch.auto write
 * grant), or the grant-aware write tools would reject every page under the
 * foreign prefix mid-run. Malformed shape or uncovered prefixes degrade to
 * `defaultTargets` with a `problem` naming the offending value(s).
 */
export function resolveTargets(
  config: Readonly<Record<string, unknown>> | undefined,
  key: string,
  defaultTargets: ReadonlyArray<string>,
  grantPatterns: ReadonlyArray<string>,
): TargetsResolution {
  const raw = config?.[key];
  if (raw === undefined) return Object.freeze({ value: defaultTargets, problem: null });
  const valid =
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every(
      (t) =>
        typeof t === "string" &&
        t.length > 0 &&
        t.trim() === t &&
        !t.startsWith("/") &&
        !t.includes("\\") &&
        !t.includes(".."),
    );
  if (!valid) {
    return Object.freeze({
      value: defaultTargets,
      problem:
        `dome.agent config ${key} must be a non-empty array of relative path prefixes; ` +
        `falling back to ${defaultTargets.join(", ")}`,
    });
  }
  const uncovered = (raw as ReadonlyArray<string>).filter(
    (t) => !grantPatterns.some((pattern) => globMatch(pattern, `${t}${GRANT_PROBE}`)),
  );
  if (uncovered.length > 0) {
    return Object.freeze({
      value: defaultTargets,
      problem:
        `dome.agent config ${key} contains prefixes outside the write grant ` +
        `(${uncovered.join(", ")} vs ${grantPatterns.join(", ")}); ` +
        `falling back to ${defaultTargets.join(", ")}`,
    });
  }
  return Object.freeze({ value: raw as ReadonlyArray<string>, problem: null });
}
