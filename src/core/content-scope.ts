// ContentScope: the complete owner-Markdown universe Dome may reason over.
//
// This is a pure policy module. It does not enumerate the filesystem, inspect
// Git, or authorize reads/writes. Callers supply candidate path strings; the
// module validates one scope and returns a canonical, deterministic selection.

import { z } from "zod";
import { globMatch } from "./glob-match";
import { canonicalVaultPath, type VaultPath } from "./vault-path";

export const CONTENT_SCOPE_VERSION = 1 as const;
export const CONTENT_SCOPE_MAX_GLOBS = 64;

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

const PRIVATE_PATH_PREFIXES = Object.freeze([".dome", ".git"] as const);
const MAX_GLOB_LENGTH = 8_192;

const globSchema = z.string().min(1).max(MAX_GLOB_LENGTH).superRefine((value, context) => {
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
export const canonicalContentScopeSchema: z.ZodType<ContentScopeConfig> = rawContentScopeSchema
  .superRefine((scope, context) => {
    for (const key of ["include", "exclude"] as const) {
      if (!isSortedUnique(scope[key])) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "must be sorted and unique",
        });
      }
    }
  })
  .transform(freezeContentScopeConfig);

/** Validate and canonicalize one versioned scope without throwing. */
export function defineContentScope(input: unknown): ContentScopeResult {
  const parsed = rawContentScopeSchema.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze(parsed.error.issues.map(contentScopeIssue)),
    });
  }

  return Object.freeze({ ok: true, scope: freezeContentScope({
    version: CONTENT_SCOPE_VERSION,
    include: sortedUnique(parsed.data.include),
    exclude: sortedUnique(parsed.data.exclude),
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
  if (pattern.startsWith("/")) return "must be vault-relative";
  if (pattern.endsWith("/")) return "must not end with a slash";
  if (pattern.includes("\\")) return "must use POSIX separators";
  if (/\p{Cc}/u.test(pattern)) return "must not contain control characters";

  const segments = pattern.split("/");
  if (segments.some((segment) => segment.length === 0)) return "must not contain empty path segments";
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "must not contain dot segments";
  }

  let braces = 0;
  let bracketStart = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "[") {
      if (bracketStart !== -1) return "must not contain nested character classes";
      bracketStart = index;
    } else if (char === "]") {
      if (bracketStart === -1 || index === bracketStart + 1) return "contains an invalid character class";
      bracketStart = -1;
    } else if (bracketStart === -1 && char === "{") {
      braces += 1;
    } else if (bracketStart === -1 && char === "}") {
      braces -= 1;
      if (braces < 0) return "contains an unmatched closing brace";
    }
  }
  if (bracketStart !== -1) return "contains an unmatched character class";
  if (braces !== 0) return "contains an unmatched opening brace";
  return null;
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
