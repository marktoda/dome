// dome.markdown.validate-wikilinks — Phase 11d adoption-phase processor.
//
// The first first-party adoption-phase processor with real behavior: parses
// `[[wikilink]]` syntax in changed markdown files and emits one
// DiagnosticEffect (severity: warning) per wikilink whose target doesn't
// resolve to a markdown file in the candidate snapshot's tree.
//
// Diagnostic-only (no PatchEffect), so the fixed-point adoption loop sees no
// patches and converges in one iteration: re-running the processor against
// the same content produces the same diagnostics, no new candidate emerges.
//
// Per [[wiki/specs/processors]] §"Adoption phase":
//   - Deterministic: same snapshot + input → same effects (the diagnostic
//     code, message, and sourceRef are pure functions of the file content +
//     the candidate snapshot's markdown set).
//   - Bounded cost: O(changed-files × wikilinks-per-file + tree-size). The
//     markdown set is materialized once per dispatch via
//     `ctx.snapshot.listMarkdownFiles()` and reused for every changed file.
//   - No LLM, no network, no patches.
//
// Per [[wiki/matrices/processor-phase-x-trigger]], adoption-phase processors
// may subscribe to `signal` triggers; we subscribe to `document.changed` (the
// markdown overlay) and `file.created` (covers newly-added paths whose
// `document.changed` may not fire if the path was added without a content
// diff — defensive).
//
// Per [[wiki/specs/effects]] §"DiagnosticEffect", `severity: "warning"` is
// recorded + surfaced in `dome status` / `dome lint` but does not block
// adoption. Broken wikilinks are a vault-hygiene finding, not a merge gate.
//
// This file lives under `assets/` which is excluded from the root
// `tsconfig.json`. Imports use relative paths into `src/`, resolved at
// runtime by Bun's dynamic-import loader (the bundle is loaded via
// `loadBundles` in `src/extensions/loader.ts`).

import {
  diagnosticEffect,
  type DiagnosticEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

// ----- Wikilink regex -------------------------------------------------------
//
// Matches `[[target]]` and `[[target|display]]`. The target is captured in
// group 1; the optional display alias is discarded (we only resolve targets).
//
//   `[[`                         — literal opening braces
//   `([^\[\]\|]+?)`              — group 1 (target): non-greedy, no `[`, `]`, `|`
//   `(?:\|[^\[\]]+)?`            — optional `|display` alias (no inner braces)
//   `]]`                         — literal closing braces
//
// `g` so we collect all matches per file; `m` is not needed because the
// pattern doesn't anchor to line boundaries (wikilinks may appear mid-line).
const WIKILINK_RE = /\[\[([^\[\]\|]+?)(?:\|[^\[\]]+)?\]\]/g;

// Common roots a bare wikilink may resolve under, in priority order. The
// resolver checks each prefix; a target like `[[danny]]` matches `wiki/danny.md`,
// then `notes/danny.md`, then `inbox/danny.md`, then `captures/danny.md`.
// Falls back to basename-anywhere search if no prefixed path matches.
const COMMON_ROOTS: ReadonlyArray<string> = [
  "wiki/",
  "notes/",
  "inbox/",
  "captures/",
];

// ----- Processor ------------------------------------------------------------

const validateWikilinks: Processor = defineProcessor({
  id: "dome.markdown.validate-wikilinks",
  version: "0.1.0",
  phase: "adoption",
  triggers: [
    { kind: "signal", name: "document.changed" },
    { kind: "signal", name: "file.created" },
  ],
  capabilities: [{ kind: "read", paths: ["**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    // Materialize the candidate snapshot's markdown set once per dispatch.
    // Build a basename → set-of-paths index alongside the full-paths set so
    // both qualified-path and bare-name resolution stay O(1) per wikilink.
    const allMarkdownPaths = await ctx.snapshot.listMarkdownFiles();
    const pathSet = new Set<string>(allMarkdownPaths);
    const basenameIndex = buildBasenameIndex(allMarkdownPaths);

    const diagnostics: DiagnosticEffect[] = [];

    // Filter changedPaths to markdown files. file.created fires for every
    // added path; we only care about markdown bodies (other file types
    // don't contain wikilink syntax).
    const changedMarkdown = ctx.changedPaths.filter((p) => p.endsWith(".md"));

    for (const changedPath of changedMarkdown) {
      const content = await ctx.snapshot.readFile(changedPath);
      // `null` means the path was deleted in the candidate; skip — there's
      // nothing to parse, and the deleted file doesn't contribute wikilinks.
      // (`file.deleted` would surface as a changedPath; we don't emit
      // diagnostics for it.)
      if (content === null) continue;

      const fileMatches = findWikilinks(content);
      for (const match of fileMatches) {
        const resolved = resolveWikilinkTarget(
          match.target,
          pathSet,
          basenameIndex,
        );
        if (resolved !== null) continue;

        // Unresolved target → emit a warning diagnostic anchored to the
        // exact span where the wikilink appears in `changedPath`. The
        // character offsets are load-bearing: they disambiguate multiple
        // wikilinks on the same line (the diagnostic dedup key is
        // (processor_id, code, proposal_id, subject_hash) where
        // subject_hash projects each SourceRef to {path, range, stableId};
        // without distinct char offsets, two broken wikilinks on one line
        // would share a subject_hash and dedupe to a single row).
        diagnostics.push(
          diagnosticEffect({
            severity: "warning",
            code: "dome.markdown.broken-wikilink",
            message: `Wikilink [[${match.target}]] does not resolve to any markdown file in the vault.`,
            sourceRefs: [
              ctx.sourceRef(changedPath, {
                startLine: match.line,
                endLine: match.line,
                startChar: match.startChar,
                endChar: match.endChar,
              }),
            ],
          }),
        );
      }
    }

    return diagnostics;
  },
});

export default validateWikilinks;

// ----- internals ------------------------------------------------------------

type WikilinkMatch = {
  readonly target: string;
  readonly line: number; // 1-indexed line number where the match begins
  readonly startChar: number; // 0-indexed column of `[[` within the line
  readonly endChar: number; // 0-indexed column of one past `]]` within the line
};

/**
 * Find every wikilink in `content`. Returns one entry per match with the
 * target (the part before `|`, if any), the 1-indexed line number, and
 * the 0-indexed start/end column within that line. The regex is reset per
 * call (fresh `lastIndex = 0`) so the module-level `WIKILINK_RE` can be
 * reused without per-call allocation.
 */
function findWikilinks(content: string): ReadonlyArray<WikilinkMatch> {
  const matches: WikilinkMatch[] = [];
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    const target = m[1];
    if (target === undefined) continue;
    const trimmed = target.trim();
    if (trimmed.length === 0) continue;
    const pos = positionAt(content, m.index);
    matches.push({
      target: trimmed,
      line: pos.line,
      startChar: pos.col,
      endChar: pos.col + m[0].length,
    });
  }
  return matches;
}

/**
 * 1-indexed line + 0-indexed column for `offset` within `content`. Walks
 * forward from the start of content counting `\n`s; the column resets
 * after each newline. Used to anchor diagnostic SourceRefs to the exact
 * span of each wikilink.
 */
function positionAt(content: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 0;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      col = 0;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

/**
 * Build a basename → set-of-paths index. The set captures collisions (e.g.,
 * `wiki/danny.md` and `notes/people/danny.md` both have basename `danny.md`)
 * so the resolver can report a match when at least one candidate exists.
 */
function buildBasenameIndex(
  paths: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const index = new Map<string, string[]>();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const base = slash >= 0 ? p.slice(slash + 1) : p;
    const bucket = index.get(base);
    if (bucket === undefined) {
      index.set(base, [p]);
    } else {
      bucket.push(p);
    }
  }
  return index;
}

/**
 * Resolve a wikilink target string against the candidate snapshot's markdown
 * set. Returns the resolved vault-relative path on success; null on miss.
 *
 * Resolution order:
 *   1. If `target` contains a slash, try resolving as a vault-relative path:
 *      first `<target>.md`, then `<target>` verbatim. This catches the
 *      explicit-path Obsidian convention (`[[wiki/entities/danny]]` →
 *      `wiki/entities/danny.md`).
 *   2. If still unresolved AND `target` contains a slash, try suffix-match:
 *      any vault path that ends with `/<target>.md` (or `/<target>`) is a
 *      candidate. This catches the partial-path Obsidian convention
 *      (`[[entities/danny]]` resolving to `wiki/entities/danny.md` —
 *      "the danny under entities/, wherever entities/ lives"). On
 *      collisions (multiple matches), returns the first; the basename
 *      index used here is insertion-ordered.
 *   3. Otherwise (bare name), look for `<target>.md` under each of the
 *      common roots (`wiki/`, `notes/`, `inbox/`, `captures/`) in order;
 *      first match wins.
 *   4. Fallback: basename-anywhere search — `<target>.md` matched against the
 *      basename index. Catches files in non-standard subdirs (e.g.,
 *      `wiki/people/danny.md` for `[[danny]]`).
 */
function resolveWikilinkTarget(
  target: string,
  pathSet: ReadonlySet<string>,
  basenameIndex: ReadonlyMap<string, ReadonlyArray<string>>,
): string | null {
  if (target.includes("/")) {
    const withMd = target.endsWith(".md") ? target : `${target}.md`;
    if (pathSet.has(withMd)) return withMd;
    if (pathSet.has(target)) return target;

    // Suffix-match: any vault path ending in `/<target>.md` is a candidate.
    // The basename index buckets by filename, so we filter to entries whose
    // full path ends with the slash-prefixed target. This matches Obsidian's
    // "shortest-suffix" wikilink resolution for `[[parent/child]]` form.
    const basename = withMd.slice(withMd.lastIndexOf("/") + 1);
    const candidates = basenameIndex.get(basename);
    if (candidates !== undefined) {
      const needle = `/${withMd}`;
      for (const candidate of candidates) {
        if (candidate.endsWith(needle)) return candidate;
      }
    }

    return null;
  }

  const filename = target.endsWith(".md") ? target : `${target}.md`;

  for (const root of COMMON_ROOTS) {
    const candidate = `${root}${filename}`;
    if (pathSet.has(candidate)) return candidate;
  }

  const basenameMatches = basenameIndex.get(filename);
  if (basenameMatches !== undefined && basenameMatches.length > 0) {
    return basenameMatches[0] ?? null;
  }

  return null;
}
