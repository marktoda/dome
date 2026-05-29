// dome.graph.links — Phase 13a adoption-phase processor.
//
// The first fact-emitting first-party processor. Scans changed `.md` files
// for `[[wikilink]]` references and emits one FactEffect per wikilink
// declaring that the changed page links to the wikilink's target. The
// target is recorded as-written (no resolution to a canonical path); a
// future view-phase processor can resolve the target string against the
// vault tree.
//
// Per [[wiki/specs/processors]] §"Adoption phase":
//   - Deterministic: same content → same FactEffects (the regex is pure,
//     the target string is recorded verbatim).
//   - Bounded cost: O(changed-files × wikilinks-per-file).
//   - No LLM, no network, no patches.
//
// Capability: declares `graph.write` over the `dome.graph.*` namespace.
// The broker enforces predicate-prefix matching at effect-emission time
// (per [[wiki/specs/capabilities]] §"graph.write"). This processor MUST
// emit only facts whose predicate starts with `dome.graph.` so its writes
// land in the declared namespace; the runtime check at the start of `run`
// is defense-in-depth — a future refactor that accidentally widens the
// predicate prefix would fail loudly here rather than silently being
// rewritten by the broker.
//
// Per [[wiki/matrices/processor-phase-x-trigger]], adoption-phase
// processors may subscribe to `signal` triggers; we subscribe to
// `document.changed`, `file.created`, and `file.deleted`. Deleted paths emit
// no facts; the projection sink clears this processor's page facts for every
// inspected changed path before inserting the run's new facts.
//
// This file lives under `assets/` which is excluded from the root
// `tsconfig.json`. Imports use relative paths into `src/`, resolved at
// runtime by Bun's dynamic-import loader.

import {
  factEffect,
  type Effect,
  type FactEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

// ----- Wikilink regex -------------------------------------------------------
//
// Matches `[[target]]` and `[[target|display]]`. The target is captured in
// group 1; the optional display alias is discarded. Same shape as the
// regex in dome.markdown.validate-wikilinks so the two processors agree on
// what constitutes a wikilink. `g` so we collect all matches per file.
const WIKILINK_RE = /\[\[([^\[\]\|]+?)(?:\|[^\[\]]+)?\]\]/g;

// Predicate the processor emits. Must start with the declared
// `dome.graph.` namespace prefix — the broker rejects out-of-namespace
// writes per [[wiki/specs/capabilities]] §"graph.write". The trailing
// segment is the relation name; `links_to` reads naturally in a triple
// "<page> links_to <target>".
const PREDICATE = "dome.graph.links_to";

// Defense-in-depth: the namespace prefix the runtime check verifies. If
// a future refactor changes PREDICATE to something outside this
// namespace, the runtime check at the start of `run` fails the
// processor's contract loudly rather than silently relying on the broker
// to reject the writes.
const REQUIRED_NAMESPACE_PREFIX = "dome.graph.";

// ----- Processor ------------------------------------------------------------

const graphLinks: Processor = defineProcessor({
  id: "dome.graph.links",
  version: "0.1.0",
  phase: "adoption",
  triggers: [
    { kind: "signal", name: "document.changed" },
    { kind: "signal", name: "file.created" },
    { kind: "signal", name: "file.deleted" },
  ],
  capabilities: [
    { kind: "read", paths: ["**/*.md"] },
    { kind: "graph.write", namespaces: ["dome.graph.*"] },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    // Defense-in-depth: refuse to emit if the processor's predicate has
    // drifted outside its declared namespace. The broker enforces this
    // at effect-emission, but a runtime assertion makes a misconfiguration
    // surface immediately at the source.
    if (!PREDICATE.startsWith(REQUIRED_NAMESPACE_PREFIX)) {
      throw new Error(
        `dome.graph.links: predicate '${PREDICATE}' does not start with the declared namespace prefix '${REQUIRED_NAMESPACE_PREFIX}'`,
      );
    }

    const facts: FactEffect[] = [];

    // `file.created` fires for every added path; the only file shape that
    // carries wikilink syntax is markdown bodies.
    const changedMarkdown = ctx.changedPaths.filter((p) => p.endsWith(".md"));

    for (const path of changedMarkdown) {
      const content = await ctx.snapshot.readFile(path);
      // `null` means the path was deleted in this candidate. The engine's
      // fact-resolution hook clears old page facts for inspected paths.
      if (content === null) continue;

      const wikilinks = findWikilinks(content);
      for (const wl of wikilinks) {
        facts.push(
          factEffect({
            subject: { kind: "page", path },
            predicate: PREDICATE,
            object: { kind: "string", value: wl.target },
            assertion: "extracted",
            sourceRefs: [
              ctx.sourceRef(path, {
                startLine: wl.line,
                endLine: wl.line,
                startChar: wl.startChar,
                endChar: wl.endChar,
              }),
            ],
          }),
        );
      }
    }

    return facts;
  },
});

export default graphLinks;

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
 * call (`lastIndex = 0`) so the module-level `WIKILINK_RE` can be reused
 * without per-call allocation.
 *
 * Mirrors the implementation in dome.markdown.validate-wikilinks — both
 * processors agree on what constitutes a wikilink. Kept duplicated rather
 * than shared because each bundle is independently shippable; introducing
 * a shared dependency between bundles would inflate the bundle-resolution
 * surface beyond what v1.0's loader supports.
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
 * forward counting `\n`s; the column resets after each newline.
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
