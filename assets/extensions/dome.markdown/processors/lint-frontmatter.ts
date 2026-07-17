// dome.markdown.lint-frontmatter — Phase 13a adoption-phase processor.
//
// Validates YAML frontmatter on changed managed markdown pages. `wiki/` pages
// must carry frontmatter and `type:`; user-owned capture/note roots may omit
// frontmatter, but any frontmatter they do include is still checked for
// parseability and well-formed structured fields. Unknown page types in those
// optional roots are informational so user-local note/capture labels do not
// create daily attention. Diagnostic-only (no PatchEffect) — failures surface
// as warnings/info; the fixed-point adoption loop converges in one iteration.
//
// Per [[wiki/specs/processors]] §"Adoption phase":
//   - Deterministic: same content → same diagnostic set (every check is a
//     pure function of the file's content; no clock, no random, no I/O
//     outside `ctx.snapshot`).
//   - Bounded cost: O(changed-files × frontmatter-size).
//   - No LLM, no network, no patches.
//
// Per-page-type schemas ARE shipped. Beyond the minimal core schema common
// to every page type, this processor loads the vault's optional
// `.dome/page-types.yaml`, merges it over `DEFAULT_PAGE_TYPE_REGISTRY`
// (see `loadPageTypeRegistry`), and then `lintPageTypeFields` enforces each
// type's required fields, flags unknown fields, and (when the registry sets
// `enforceKnownTypes`) flags `type:` values that name no known page type.
// A malformed or conflicting `page-types.yaml` itself surfaces as a finding
// against that path. See [[wiki/specs/page-schema]] for the contract.
//
// Per [[wiki/matrices/processor-phase-x-trigger]], adoption-phase
// processors may subscribe to `signal` triggers; we subscribe to
// `document.changed` (markdown overlay) and `file.created` (covers
// newly-added paths whose `document.changed` may not fire if the path
// was added without a content diff — defensive, matches sibling
// processors validate-wikilinks + normalize-frontmatter).
//
// Per [[wiki/specs/effects]] §"DiagnosticEffect", `severity: "warning"`
// creates operator attention but does not block adoption. Optional-root
// unknown-type findings use `severity: "info"` because they preserve useful
// visibility without treating user-owned note taxonomy as curated-wiki drift.
//
// This file lives under `assets/` which is excluded from the root
// `tsconfig.json`. Imports use relative paths into `src/`, resolved at
// runtime by Bun's dynamic-import loader. The `gray-matter` import
// resolves via Bun's node_modules lookup (gray-matter is already a
// runtime dep of @marktoda/dome per package.json).

import matter from "gray-matter";

import {
  diagnosticEffect,
  type DiagnosticEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import {
  DEFAULT_PAGE_TYPE_REGISTRY,
  extendPageTypeRegistry,
  parsePageTypesYaml,
  type PageTypeRegistry,
  type PageTypeSchema,
} from "../../../../src/page-types";
import {
  frontmatterLintModeForPath,
  type FrontmatterLintMode,
} from "./path-policy";

// ----- Diagnostic codes -----------------------------------------------------
//
// Codes are stable across versions — downstream tooling
// (`dome inspect diagnostics --code <X>`) consumes them. Severity is mostly
// warning, except optional-root unknown `type:` values and the
// missing-description gradual-fill nudge, which are info.

const CODE_MISSING_FRONTMATTER = "dome.markdown.missing-frontmatter";
const CODE_MISSING_TYPE = "dome.markdown.missing-type";
const CODE_INVALID_DATE = "dome.markdown.invalid-date";
const CODE_TAGS_NOT_LIST = "dome.markdown.tags-not-list";
const CODE_MALFORMED_YAML = "dome.markdown.malformed-yaml";
const CODE_PAGE_TYPES_MALFORMED = "dome.markdown.page-types-malformed";
const CODE_UNKNOWN_TYPE = "dome.markdown.type-unknown";
const CODE_MISSING_REQUIRED_FIELD = "dome.markdown.missing-required-field";
const CODE_UNKNOWN_FRONTMATTER_FIELD = "dome.markdown.unknown-frontmatter-field";
const CODE_MISSING_DESCRIPTION = "dome.markdown.missing-description";
const PAGE_TYPES_PATH = ".dome/page-types.yaml";

// ----- Processor ------------------------------------------------------------

const lintFrontmatter = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const diagnostics: DiagnosticEffect[] = [];
    const pageTypes = await loadPageTypeRegistry(ctx);
    if (pageTypes.finding !== null) {
      diagnostics.push(
        diagnosticForFinding(ctx, PAGE_TYPES_PATH, pageTypes.finding, "required"),
      );
    }

    // `file.created` fires for every added path; only managed markdown roots
    // participate in frontmatter linting.
    const changedMarkdown = ctx.changedPaths.filter(
      (path) => frontmatterLintModeForPath(path) !== "ignored",
    );

    for (const path of changedMarkdown) {
      const mode = frontmatterLintModeForPath(path);
      const content = await ctx.snapshot.readFile(path);
      // `null` → path deleted or never existed in the candidate; nothing
      // to lint.
      if (content === null) continue;

      const findings = lintContent(
        content,
        pageTypes.registry,
        mode,
      );
      for (const f of findings) {
        diagnostics.push(diagnosticForFinding(ctx, path, f, mode));
      }
    }

    return diagnostics;
  },
});

export default lintFrontmatter;

// ----- internals ------------------------------------------------------------

type Finding = {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
};

/**
 * Detect whether the file has a frontmatter block. gray-matter accepts a
 * file with no `---` delimiters and returns `data === {}` + `isEmpty:
 * false` — indistinguishable at the `data` level from a file with `---\n---`
 * (which returns `data === {}` + `isEmpty: true`). Detecting the
 * "no-delimiters" case before parsing lets the lint surface
 * `missing-frontmatter` accurately.
 *
 * The check is intentionally simple: a frontmatter block requires `---` at
 * the start of file (column 0, line 1). Trailing-whitespace or BOM edge
 * cases are common authoring mistakes but out of scope for v1.0 — a
 * future tightening pass can normalize via `content.trimStart()`.
 */
function hasFrontmatterDelimiter(content: string): boolean {
  // The first three characters must be `---` and the next character (if
  // present) must be a newline or end-of-string. Anchored at the very
  // start of the file.
  if (!content.startsWith("---")) return false;
  const next = content.charAt(3);
  return next === "\n" || next === "\r" || next === "";
}

/**
 * Lint a single markdown file's content. Returns an array of findings (may
 * be empty). Pure — no I/O, no clock; the same input always produces the
 * same output.
 *
 * Findings ordering: malformed-yaml (terminal — no other check runs);
 * missing-frontmatter (terminal — no other check runs); then per-field
 * checks (missing-type, invalid-date, tags-not-list) in a deterministic
 * order. Multiple findings on the same file CAN coexist (e.g.,
 * `missing-type` + `invalid-date` + `tags-not-list`).
 */
function lintContent(
  content: string,
  pageTypes: PageTypeRegistry,
  mode: FrontmatterLintMode,
): ReadonlyArray<Finding> {
  if (!hasFrontmatterDelimiter(content)) {
    if (mode === "optional") return [];
    return [
      {
        code: CODE_MISSING_FRONTMATTER,
        message: "Markdown file has no YAML frontmatter block.",
      },
    ];
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (e) {
    // gray-matter's YAML engine (js-yaml) throws a YAMLException on
    // malformed YAML. Surface the parser's message so the operator can
    // localize the error inside the frontmatter block.
    const cause = e instanceof Error ? e.message : String(e);
    return [
      {
        code: CODE_MALFORMED_YAML,
        message: `Frontmatter YAML is malformed: ${cause}`,
      },
    ];
  }

  // `isEmpty: true` → `---\n---` with no content between delimiters.
  // Required pages report this as missing-frontmatter; optional-frontmatter
  // roots treat it as equivalent to no metadata.
  if (matterFileIsEmpty(parsed) || Object.keys(parsed.data).length === 0) {
    if (mode === "optional") return [];
    return [
      {
        code: CODE_MISSING_FRONTMATTER,
        message: "Markdown file has an empty YAML frontmatter block.",
      },
    ];
  }

  const findings: Finding[] = [];
  const data = parsed.data;

  // `type:` check — required, must be a non-empty string.
  const typeValue = data["type"];
  let normalizedType: string | null = null;
  if (
    typeValue === undefined ||
    typeValue === null ||
    (typeof typeValue === "string" && typeValue.trim().length === 0)
  ) {
    if (mode === "required") {
      findings.push({
        code: CODE_MISSING_TYPE,
        message: "Frontmatter is missing the required `type:` key.",
      });
    }
  } else if (typeof typeValue !== "string") {
    findings.push({
      code: CODE_MISSING_TYPE,
      message: `Frontmatter \`type:\` must be a string (got: ${describeValue(typeValue)}).`,
    });
  } else {
    normalizedType = typeValue.trim();
  }

  // `created:` / `updated:` checks — optional, but if present must be a
  // parseable ISO-8601 date or a JS Date (gray-matter coerces unquoted
  // ISO date literals into `Date` objects).
  for (const key of ["created", "updated"]) {
    if (!(key in data)) continue;
    const value = data[key];
    if (!isValidIsoDate(value)) {
      findings.push({
        code: CODE_INVALID_DATE,
        message: `Frontmatter \`${key}:\` is not a parseable ISO-8601 date (got: ${describeValue(value)}).`,
      });
    }
  }

  // `tags:` check — optional, but if present must be a YAML list. A list
  // in JS lands as a JS array; gray-matter / js-yaml never coerces a
  // bare string into an array.
  if ("tags" in data) {
    const tagsValue = data["tags"];
    if (!Array.isArray(tagsValue)) {
      findings.push({
        code: CODE_TAGS_NOT_LIST,
        message: `Frontmatter \`tags:\` must be a YAML list (got: ${describeValue(tagsValue)}).`,
      });
    }
  }

  if (normalizedType !== null) {
    findings.push(...lintPageTypeFields(data, normalizedType, pageTypes));
  }

  // `description:` nudge — required-mode (curated wiki) pages should carry a
  // one-line description; it feeds the generated index and search. Info
  // severity (gradual fill, never adoption noise), so it sits after the
  // warning-grade checks above.
  const descriptionValue = data["description"];
  if (
    mode === "required" &&
    (typeof descriptionValue !== "string" ||
      descriptionValue.trim().length === 0)
  ) {
    findings.push({
      code: CODE_MISSING_DESCRIPTION,
      message:
        "Add a one-line `description:` — it feeds the generated index and search.",
    });
  }

  return findings;
}

function matterFileIsEmpty(file: matter.GrayMatterFile<string>): boolean {
  return (file as matter.GrayMatterFile<string> & { readonly isEmpty?: boolean })
    .isEmpty === true;
}

function lintPageTypeFields(
  data: Record<string, unknown>,
  typeName: string,
  registry: PageTypeRegistry,
): ReadonlyArray<Finding> {
  const schema = registry.types.get(typeName);
  if (schema === undefined) {
    if (!registry.enforceKnownTypes) return [];
    return [
      {
        code: CODE_UNKNOWN_TYPE,
        message: `Frontmatter \`type:\` references unknown page type "${typeName}".`,
      },
    ];
  }

  const findings: Finding[] = [];
  for (const field of schema.required) {
    if (!hasMeaningfulValue(data[field])) {
      findings.push({
        code: CODE_MISSING_REQUIRED_FIELD,
        message:
          `Page type "${typeName}" requires frontmatter field \`${field}:\`.`,
      });
    }
  }

  const known = knownFieldsFor(schema);
  for (const field of Object.keys(data).sort()) {
    if (known.has(field)) continue;
    findings.push({
      code: CODE_UNKNOWN_FRONTMATTER_FIELD,
      message:
        `Frontmatter field \`${field}:\` is not declared for page type "${typeName}".`,
    });
  }
  return findings;
}

async function loadPageTypeRegistry(ctx: ProcessorContext): Promise<{
  readonly registry: PageTypeRegistry;
  readonly finding: Finding | null;
}> {
  const base = ctx.pageTypes ?? DEFAULT_PAGE_TYPE_REGISTRY;
  const content = await ctx.snapshot.readFile(PAGE_TYPES_PATH);
  if (content === null) {
    return { registry: base, finding: null };
  }

  const parsed = parsePageTypesYaml(content, PAGE_TYPES_PATH);
  if (!parsed.ok) {
    return {
      registry: base,
      finding: {
        code: CODE_PAGE_TYPES_MALFORMED,
        message: `.dome/page-types.yaml does not match the page-types schema: ${parsed.error.message}`,
      },
    };
  }

  const merged = extendPageTypeRegistry(base, parsed.value, {
    enforceKnownTypes: true,
  });
  if (!merged.ok) {
    return {
      registry: base,
      finding: {
        code: CODE_PAGE_TYPES_MALFORMED,
        message:
          `.dome/page-types.yaml redeclares page type "${merged.error.name}" ` +
          `already declared by ${merged.error.firstSource}.`,
      },
    };
  }

  return { registry: merged.value, finding: null };
}

function knownFieldsFor(schema: PageTypeSchema): ReadonlySet<string> {
  return new Set([
    "type",
    "created",
    "updated",
    "sources",
    "tags",
    // description is universal because the missing-description nudge asks
    // every required-mode page for one regardless of type — extension types
    // must not be flagged for complying.
    "description",
    ...schema.required,
    ...schema.optional,
  ]);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function diagnosticForFinding(
  ctx: ProcessorContext,
  path: string,
  finding: Finding,
  mode: FrontmatterLintMode,
): DiagnosticEffect {
  const line = finding.line ?? 1;
  return diagnosticEffect({
    severity: severityForFinding(finding, mode),
    code: finding.code,
    message: finding.message,
    sourceRefs: [ctx.sourceRef(path, { startLine: line, endLine: line })],
  });
}

function severityForFinding(
  finding: Finding,
  mode: FrontmatterLintMode,
): DiagnosticEffect["severity"] {
  if (mode === "optional" && finding.code === CODE_UNKNOWN_TYPE) {
    return "info";
  }
  // missing-description is a gradual-fill nudge, never adoption noise.
  if (finding.code === CODE_MISSING_DESCRIPTION) {
    return "info";
  }
  return "warning";
}

/**
 * Validate that `value` is a parseable ISO-8601 date. Accepts:
 *   - A `Date` instance (gray-matter coerces unquoted ISO date literals
 *     into Date objects via js-yaml's `timestamp` type).
 *   - A string that `new Date(...)` can parse without producing `NaN`.
 *
 * `null` / `undefined` / other types return false (the key was present
 * but the value isn't date-shaped).
 *
 * Pure — no clock, no locale-dependent parsing.
 */
function isValidIsoDate(value: unknown): boolean {
  if (value instanceof Date) {
    // `Date` constructor accepts garbage strings and stores `NaN`; the
    // `getTime()` method returns NaN for invalid Date objects.
    return !Number.isNaN(value.getTime());
  }
  if (typeof value !== "string") return false;
  if (value.trim().length === 0) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

/**
 * Describe `value` for inclusion in a diagnostic message. Truncates long
 * stringifications to keep messages readable.
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    return value.length > 40 ? `"${value.slice(0, 40)}..."` : `"${value}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  // Object / array — describe shape, not full contents.
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}
