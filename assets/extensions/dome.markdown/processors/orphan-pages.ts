// dome.markdown.orphan-pages — Phase 13a view-phase processor.
//
// The first view-phase processor with real behavior. Invoked on demand
// via `dome run orphan-pages`, reads the projection's `links_to` facts
// (emitted by `dome.graph.links`), computes incoming-link counts per
// markdown page, and emits a single `ViewEffect` listing every page
// with zero incoming links AND not already implicitly linked from a
// root index page.
//
// Per [[wiki/specs/processors]] §"View phase":
//   - Read-only — never mutates state. The broker rejects PatchEffect /
//     DiagnosticEffect(block) / FactEffect / QuestionEffect /
//     ExternalActionEffect from view-phase processors.
//   - Reads from the projection store ([[wiki/specs/projection-store]])
//     for indexed facts via `ctx.projection.facts(...)`.
//   - Reads the adopted snapshot via `ctx.snapshot` to enumerate every
//     markdown file in the vault tree (so pages with no facts at all
//     are also evaluated for orphan status).
//
// Root-index implicit-edges rule:
//   For four canonical root directories (`wiki/`, `notes/`, `inbox/`,
//   `captures/`), the file `<root>/index.md` is assumed to implicitly
//   link to every other file under `<root>/` even without explicit
//   wikilink syntax. So:
//     - `wiki/index.md` is NEVER orphan.
//     - `wiki/foo.md` with 0 incoming explicit wikilinks IS orphan
//       UNLESS `wiki/index.md` contains an explicit `[[foo]]` link.
//   The implicit-edge convention prevents the obvious false positives
//   ("every file is orphan because nothing wikilinks to it directly")
//   while keeping the rule simple — Phase 14+ may refine to a richer
//   "incoming-edge graph" implementation when the substrate lands.
//
// Per the v1.0 ViewEffect shape, the payload uses `content.kind:
// "structured"` with a schema id (`dome.markdown.orphan-pages/v1`) so
// downstream renderers can validate against the schema. The structured
// data shape is documented at the call site and mirrored in the
// `dome run orphan-pages` JSON output.
//
// This file lives under `assets/` which is excluded from the root
// `tsconfig.json`. Imports use relative paths into `src/`, resolved at
// runtime by Bun's dynamic-import loader.

import {
  viewEffect,
  type Effect,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

// ----- Constants ------------------------------------------------------------

const VIEW_NAME = "dome.markdown.orphan-pages";
const VIEW_SCHEMA = "dome.markdown.orphan-pages/v1";

// The four canonical root directories whose `index.md` carries implicit
// edges to every other file under that root. Suffix-included so prefix
// matches are exact.
const ROOT_DIRS: ReadonlyArray<string> = [
  "wiki/",
  "notes/",
  "inbox/",
  "captures/",
];

// Predicate the orphan-pages processor queries for incoming-link facts.
// This MUST match the predicate `dome.graph.links` emits — they're
// coupled by name. If `dome.graph.links` changes its predicate, this
// file must be updated.
const LINKS_TO_PREDICATE = "dome.graph.links_to";

// ----- Processor ------------------------------------------------------------

const orphanPages = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const projection = ctx.projection;
    if (projection === undefined) {
      // The runtime that invokes view-phase processors MUST wire a
      // projection query view; an undefined slot here is a wiring
      // defect. Fail loudly rather than silently treating "no facts"
      // as "every page is orphan".
      throw new Error(
        "dome.markdown.orphan-pages: ctx.projection is undefined — the runtime must wire a ProjectionQueryView for view-phase processors",
      );
    }

    // 1. Enumerate every markdown file in the vault.
    const allMarkdown = await ctx.snapshot.listMarkdownFiles();

    // 2. Read every `links_to` fact and build an incoming-link index.
    //    The map's keys are link targets *as written* in the wikilink
    //    (e.g., "foo", "entities/danny"); values are the count of pages
    //    that link to that target. Multiple links from the same page
    //    count multiple times.
    const linkTargets = projection.facts({ predicate: LINKS_TO_PREDICATE });
    const incomingLinkCounts = new Map<string, number>();
    for (const fact of linkTargets) {
      // Object is a Literal { kind: "string", value: "..." } — the
      // dome.graph.links processor records targets as string literals.
      // Skip if the shape isn't what we expect (defensive against
      // schema drift; should not happen in v1).
      const obj = fact.object;
      if (obj.kind !== "string") continue;
      const target = obj.value;
      incomingLinkCounts.set(target, (incomingLinkCounts.get(target) ?? 0) + 1);
    }

    // 3. Build the basename index so we can resolve link-target strings
    //    to vault paths (a link `[[foo]]` resolves to `wiki/foo.md` etc.).
    //    A page is "incoming-linked" if ANY of its basenames or path
    //    forms appears as a link target.
    const targetsSet = new Set<string>(incomingLinkCounts.keys());

    // 4. Identify root-index pages and their implicit incoming-edges.
    //    For each root dir, if `<root>/index.md` exists in the tree,
    //    every other file under `<root>/` gets a 1-point implicit
    //    incoming edge (from that index page).
    const implicitlyLinked = computeImplicitlyLinked(allMarkdown);

    // 5. Compute orphans. A page is orphan when:
    //    (a) It is NOT itself a root index page (always non-orphan).
    //    (b) It has NO incoming explicit wikilinks (target string in
    //        `targetsSet`).
    //    (c) It is NOT in the implicitly-linked set.
    const orphans: Array<{
      readonly path: string;
      readonly incomingLinkCount: 0;
      readonly reason: "no incoming links and not in root index";
    }> = [];

    let totalScanned = 0;
    for (const path of allMarkdown) {
      totalScanned += 1;

      // (a) Root-index pages are never orphan.
      if (isRootIndexPage(path)) continue;

      // (b) Check for any incoming explicit wikilink that resolves to
      //     this page. The resolution mirrors validate-wikilinks:
      //     match by full vault path or by basename.
      if (pathHasIncomingWikilink(path, targetsSet)) continue;

      // (c) Root-index-implicit edge.
      if (implicitlyLinked.has(path)) {
        // Pages implicitly linked from their root index are NOT orphan,
        // BUT note the reason in the report: this is a useful signal
        // ("this page would be orphan if its index didn't exist").
        // For v1, we treat them as fully non-orphan and exclude from
        // the orphan list.
        continue;
      }

      // All three filters passed — this is an orphan.
      orphans.push({
        path,
        incomingLinkCount: 0,
        reason: "no incoming links and not in root index",
      });
    }

    // 6. Emit the view effect.
    const payload = {
      schema: VIEW_SCHEMA,
      asOfCommit: ctx.snapshot.commit,
      orphans,
      totalScanned,
      totalOrphans: orphans.length,
    };

    const effect: ViewEffect = viewEffect({
      name: VIEW_NAME,
      content: {
        kind: "structured",
        data: payload,
        schema: VIEW_SCHEMA,
      },
      // Scope = every orphan page's SourceRef anchored at line 1. The
      // view consumer can use these to navigate to the orphan files.
      scope: orphans.map((o) =>
        ctx.sourceRef(o.path, { startLine: 1, endLine: 1 }),
      ),
    });

    return [effect];
  },
});

export default orphanPages;

// ----- internals ------------------------------------------------------------

/**
 * Is `path` a root-index page (e.g., `wiki/index.md`)? Root indexes
 * are always treated as non-orphan because they're top-level
 * directory entry points.
 */
function isRootIndexPage(path: string): boolean {
  for (const root of ROOT_DIRS) {
    if (path === `${root}index.md`) return true;
  }
  return false;
}

/**
 * Compute the set of vault paths that are implicitly linked from their
 * root's `index.md`. A page `wiki/foo.md` is implicitly linked iff
 * `wiki/index.md` exists in the markdown set. The implicit-edges rule
 * doesn't require `wiki/index.md` to actually contain `[[foo]]` —
 * convention is that the root index summarizes its directory tree,
 * even if the listing is auto-generated.
 *
 * v1.0 implementation: a directory's index page exists → every other
 * file under that directory is implicitly linked. Phase 14+ may refine
 * this to "the index page actually mentions this file in its body."
 */
function computeImplicitlyLinked(
  allMarkdown: ReadonlyArray<string>,
): ReadonlySet<string> {
  const markdownSet = new Set<string>(allMarkdown);
  const implicit = new Set<string>();

  for (const root of ROOT_DIRS) {
    const indexPath = `${root}index.md`;
    if (!markdownSet.has(indexPath)) continue;
    // Every other markdown file under <root>/ is implicitly linked.
    for (const path of allMarkdown) {
      if (path === indexPath) continue;
      if (path.startsWith(root)) implicit.add(path);
    }
  }

  return implicit;
}

/**
 * Decide whether `path` has any incoming wikilink. A wikilink target
 * matches `path` when ANY of the following resolve to `path`:
 *
 *   - The target is exactly `path` (e.g., `[[wiki/entities/danny.md]]`).
 *   - The target with `.md` appended is exactly `path`
 *     (e.g., `[[wiki/entities/danny]]`).
 *   - The target's basename + `.md` matches the basename of `path`
 *     (e.g., `[[danny]]` matching `wiki/entities/danny.md`).
 *
 * This mirrors validate-wikilinks's resolution order (the targets the
 * graph processor records). Pages with collisions on basename
 * (e.g., two `danny.md` files) are conservatively treated as linked —
 * we cannot tell from the target string alone which one is meant, so
 * the safer choice is to NOT flag either as orphan. The cost is a
 * possible false negative; the alternative is a possible false
 * positive that breaks user trust.
 */
function pathHasIncomingWikilink(
  path: string,
  targetsSet: ReadonlySet<string>,
): boolean {
  // Exact path match.
  if (targetsSet.has(path)) return true;
  // Path without `.md` extension (the common Obsidian form).
  if (path.endsWith(".md")) {
    const stem = path.slice(0, -3);
    if (targetsSet.has(stem)) return true;
  }
  // Basename match (e.g., `[[danny]]` → `wiki/entities/danny.md`).
  const slash = path.lastIndexOf("/");
  const basenameWithExt = slash >= 0 ? path.slice(slash + 1) : path;
  const basename = basenameWithExt.endsWith(".md")
    ? basenameWithExt.slice(0, -3)
    : basenameWithExt;
  if (targetsSet.has(basename)) return true;
  if (targetsSet.has(basenameWithExt)) return true;
  return false;
}
