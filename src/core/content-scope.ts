// ContentScope: the complete owner-Markdown universe Dome may reason over.
//
// This is a pure policy module. It does not enumerate the filesystem, inspect
// Git, or authorize reads/writes. Callers supply candidate path strings; the
// module validates one scope and returns a canonical, deterministic selection.

import { types as utilTypes } from "node:util";
import { z } from "zod";
import { globMatch } from "./glob-match";
import { canonicalVaultPath, type VaultPath } from "./vault-path";

export const CONTENT_SCOPE_VERSION = 1 as const;
export const CONTENT_SCOPE_MAX_GLOBS = 64;
export const CONTENT_SCOPE_MAX_ERRORS = 16;

declare const CONTENT_SCOPE_BRAND: unique symbol;

export type ContentScopeConfig = Readonly<{
  version: typeof CONTENT_SCOPE_VERSION;
  include: ReadonlyArray<string>;
  exclude: ReadonlyArray<string>;
}>;

export type ContentScope = ContentScopeConfig & Readonly<{
  [CONTENT_SCOPE_BRAND]: true;
}>;

export type ContentScopeValidationError = Readonly<{
  code:
    | "invalid-shape"
    | "unsupported-version"
    | "missing-include"
    | "too-many-globs"
    | "invalid-glob";
  path: string;
  message: string;
}>;

export type ContentScopeResult =
  | Readonly<{ ok: true; scope: ContentScope }>
  | Readonly<{ ok: false; errors: ReadonlyArray<ContentScopeValidationError> }>;

/** Broad visible-owner-Markdown policy written into newly configured vaults. */
export const DEFAULT_CONTENT_SCOPE_CONFIG: ContentScopeConfig = Object.freeze({
  version: CONTENT_SCOPE_VERSION,
  include: Object.freeze(["**/*.md"]),
  exclude: Object.freeze([".dome/**", ".git/**"]),
});

const PRIVATE_PATH_PREFIXES = Object.freeze([".dome", ".git"] as const);
const MAX_GLOB_LENGTH = 8_192;

const globSchema = z.string().superRefine((value, context) => {
  const reason = invalidGlobReason(value);
  if (reason !== null) context.addIssue({ code: "custom", message: reason });
});

const rawContentScopeSchema = z.object({
  version: z.literal(CONTENT_SCOPE_VERSION),
  include: z.array(globSchema).min(1).max(CONTENT_SCOPE_MAX_GLOBS),
  exclude: z.array(globSchema).max(CONTENT_SCOPE_MAX_GLOBS),
}).strict();

/**
 * Schema for revision-bound JSON contracts that are already canonical.
 * `defineContentScope` is the ergonomic constructor for unordered input.
 */
export const canonicalContentScopeSchema: z.ZodType<ContentScopeConfig> = z.unknown()
  .transform((input, context) => {
    const parsed = validateRawContentScope(input);
    if (!parsed.ok) {
      for (const error of parsed.errors) {
        context.addIssue({
          code: "custom",
          path: zodPath(error.path),
          message: error.message,
        });
      }
      return z.NEVER;
    }

    let canonical = true;
    for (const key of ["include", "exclude"] as const) {
      if (!isSortedUnique(parsed.value[key])) {
        canonical = false;
        context.addIssue({
          code: "custom",
          path: [key],
          message: "must be sorted and unique",
        });
      }
    }
    return canonical ? freezeContentScopeConfig(parsed.value) : z.NEVER;
  });

/** Validate and canonicalize one versioned scope without throwing. */
export function defineContentScope(input: unknown): ContentScopeResult {
  const parsed = validateRawContentScope(input);
  if (!parsed.ok) {
    return Object.freeze({
      ok: false,
      errors: parsed.errors,
    });
  }

  return Object.freeze({ ok: true, scope: freezeContentScope({
    version: CONTENT_SCOPE_VERSION,
    include: sortedUnique(parsed.value.include),
    exclude: sortedUnique(parsed.value.exclude),
  }) });
}

/**
 * Decide whether a candidate belongs to the scope. Paths are canonicalized
 * before matching. Only lowercase `.md` is Markdown; exclusions and the
 * unconditional `.dome/**` / `.git/**` floor win over includes.
 */
export function contentScopeContains(scope: ContentScope, rawPath: string): boolean {
  const path = canonicalVaultPath(rawPath);
  if (path === null || !path.endsWith(".md") || isPrivatePath(path)) return false;
  if (scope.exclude.some((pattern) => globMatch(pattern, path))) return false;
  return scope.include.some((pattern) => globMatch(pattern, path));
}

/** Canonicalize, de-duplicate, filter, and lexically sort candidate paths. */
export function selectContentScope(
  scope: ContentScope,
  candidates: ReadonlyArray<string>,
): ReadonlyArray<VaultPath> {
  const selected = new Set<VaultPath>();
  for (const rawPath of candidates) {
    const path = canonicalVaultPath(rawPath);
    if (path !== null && contentScopeContains(scope, path)) selected.add(path);
  }
  return Object.freeze([...selected].sort());
}

/** Deterministic YAML mapping shared by fresh config and setup migration renderers. */
export function renderContentScopeYaml(input: ContentScopeConfig): string {
  const scope = canonicalContentScopeSchema.parse(input);
  return [
    "content_scope:",
    `  version: ${scope.version}`,
    "  include:",
    ...scope.include.map((glob) => `    - ${JSON.stringify(glob)}`),
    "  exclude:",
    ...scope.exclude.map((glob) => `    - ${JSON.stringify(glob)}`),
    "",
  ].join("\n");
}

function freezeContentScope(scope: {
  version: typeof CONTENT_SCOPE_VERSION;
  include: ReadonlyArray<string>;
  exclude: ReadonlyArray<string>;
}): ContentScope {
  return freezeContentScopeConfig(scope) as ContentScope;
}

function freezeContentScopeConfig(scope: {
  version: typeof CONTENT_SCOPE_VERSION;
  include: ReadonlyArray<string>;
  exclude: ReadonlyArray<string>;
}): ContentScopeConfig {
  return Object.freeze({
    version: CONTENT_SCOPE_VERSION,
    include: Object.freeze([...scope.include]),
    exclude: Object.freeze([...scope.exclude]),
  });
}

function sortedUnique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].sort();
}

function isSortedUnique(values: ReadonlyArray<string>): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function isPrivatePath(path: VaultPath): boolean {
  const first = path.split("/", 1)[0];
  return PRIVATE_PATH_PREFIXES.some((prefix) => first === prefix);
}

function invalidGlobReason(pattern: string): string | null {
  if (pattern.length === 0) return "must not be empty";
  if (pattern.length > MAX_GLOB_LENGTH) return `must contain at most ${MAX_GLOB_LENGTH} characters`;
  if (pattern.startsWith("/")) return "must be vault-relative";
  if (pattern.endsWith("/")) return "must not end with a slash";
  if (pattern.includes("\\")) return "must use POSIX separators";
  if (/\p{Cc}/u.test(pattern)) return "must not contain control characters";

  const segments = pattern.split("/");
  if (segments.some((segment) => segment.length === 0)) return "must not contain empty path segments";
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "must not contain dot segments";
  }

  try {
    new Bun.Glob(pattern);
  } catch {
    return "must be accepted by Bun.Glob";
  }
  return null;
}

type RawContentScope = z.infer<typeof rawContentScopeSchema>;
type RawContentScopeResult =
  | Readonly<{ ok: true; value: RawContentScope }>
  | Readonly<{ ok: false; errors: ReadonlyArray<ContentScopeValidationError> }>;

function validateRawContentScope(input: unknown): RawContentScopeResult {
  try {
    const preflight = snapshotRawContentScope(input);
    if (!preflight.ok) return Object.freeze({ ok: false, errors: preflight.errors });

    const parsed = rawContentScopeSchema.safeParse(preflight.value);
    if (parsed.success) return Object.freeze({ ok: true, value: parsed.data });
    return Object.freeze({
      ok: false,
      errors: freezeErrors(parsed.error.issues.map(contentScopeIssue)),
    });
  } catch {
    return invalidRawContentScope("validation failed while inspecting passive data");
  }
}

type RawContentScopeSnapshotResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; errors: ReadonlyArray<ContentScopeValidationError> }>;

/** Compile an inert snapshot before Zod can observe user-controlled accessors. */
function snapshotRawContentScope(input: unknown): RawContentScopeSnapshotResult {
  try {
    if (typeof input !== "object" || input === null) {
      return Object.freeze({ ok: true, value: input });
    }
    if (utilTypes.isProxy(input)) return invalidRawContentScope("must not be a Proxy");
    if (Array.isArray(input)) return invalidRawContentScope("must be a plain data object");

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidRawContentScope("must be a plain data object");
    }
    const enumerableKeys = Object.keys(input);
    if (enumerableKeys.some((key) => !["version", "include", "exclude"].includes(key))) {
      return invalidRawContentScope("must contain only version, include, and exclude");
    }

    const errors: ContentScopeValidationError[] = [];
    const snapshot: Record<string, unknown> = {};
    for (const key of ["version", "include", "exclude"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined) continue;
      if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        errors.push({
          code: "invalid-shape",
          path: key,
          message: "must be an enumerable data property",
        });
        continue;
      }
      if (key === "version") {
        snapshot.version = descriptor.value;
        continue;
      }
      if (!Array.isArray(descriptor.value)) {
        errors.push({
          code: "invalid-shape",
          path: key,
          message: "must be an array",
        });
        continue;
      }
      const array = snapshotPassiveArray(descriptor.value, key);
      if (!array.ok) {
        errors.push(...array.errors);
      } else {
        snapshot[key] = array.value;
      }
    }
    if (errors.length > 0) {
      return Object.freeze({ ok: false, errors: freezeErrors(errors) });
    }
    return Object.freeze({ ok: true, value: Object.freeze(snapshot) });
  } catch {
    return invalidRawContentScope("must be an inspectable data object");
  }
}

type PassiveArrayResult =
  | Readonly<{ ok: true; value: ReadonlyArray<unknown> }>
  | Readonly<{ ok: false; errors: ReadonlyArray<ContentScopeValidationError> }>;

function snapshotPassiveArray(input: unknown[], path: "include" | "exclude"): PassiveArrayResult {
  try {
    if (utilTypes.isProxy(input)) return invalidPassiveArray(path, "must not be a Proxy");
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      return invalidPassiveArray(path, "must have a valid array length");
    }
    if (length > CONTENT_SCOPE_MAX_GLOBS) {
      return Object.freeze({
        ok: false,
        errors: freezeErrors([{
          code: "too-many-globs",
          path,
          message: `must contain at most ${CONTENT_SCOPE_MAX_GLOBS} globs`,
        }]),
      });
    }

    const enumerableKeys = Object.keys(input);
    if (enumerableKeys.some((key) => !isBoundedArrayIndex(key, length))) {
      return invalidPassiveArray(path, "must contain indexed elements only");
    }

    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined) {
        snapshot.push(undefined);
      } else if (descriptor.get !== undefined || descriptor.set !== undefined) {
        return invalidPassiveArray(path, "must contain data elements only");
      } else {
        snapshot.push(descriptor.value);
      }
    }
    return Object.freeze({ ok: true, value: Object.freeze(snapshot) });
  } catch {
    return invalidPassiveArray(path, "must be an inspectable data array");
  }
}

function isBoundedArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function invalidPassiveArray(
  path: "include" | "exclude",
  message: string,
): PassiveArrayResult {
  return Object.freeze({
    ok: false,
    errors: freezeErrors([{
      code: "invalid-shape",
      path,
      message,
    }]),
  });
}

function invalidRawContentScope(message: string): Extract<RawContentScopeResult, { ok: false }> {
  return Object.freeze({
    ok: false,
    errors: freezeErrors([{
      code: "invalid-shape",
      path: "$",
      message,
    }]),
  });
}

function freezeErrors(
  errors: ReadonlyArray<ContentScopeValidationError>,
): ReadonlyArray<ContentScopeValidationError> {
  return Object.freeze(errors.slice(0, CONTENT_SCOPE_MAX_ERRORS).map((error) => Object.freeze({ ...error })));
}

function zodPath(path: string): Array<string | number> {
  if (path === "$") return [];
  return path.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part);
}

function contentScopeIssue(issue: z.ZodIssue): ContentScopeValidationError {
  const path = issue.path.length === 0 ? "$" : issue.path.join(".");
  let code: ContentScopeValidationError["code"] = "invalid-shape";
  if (issue.path[0] === "version") code = "unsupported-version";
  else if (issue.path[0] === "include" && issue.path.length === 1 && issue.code === "too_small") {
    code = "missing-include";
  } else if (
    (issue.path[0] === "include" || issue.path[0] === "exclude") &&
    issue.path.length === 1 &&
    issue.code === "too_big"
  ) {
    code = "too-many-globs";
  } else if ((issue.path[0] === "include" || issue.path[0] === "exclude") && issue.path.length > 1) {
    code = "invalid-glob";
  }
  return Object.freeze({ code, path, message: issue.message });
}
