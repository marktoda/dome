// dome.claims.render-facts — garden processor: compile a deterministic
// `## Current facts` digest block for claim-rich ENTITY pages. Snapshot-in →
// patches-out: it reads page content off the snapshot (garden processors
// can't read the projection) and re-parses claim lines with the shared
// `claimsFromMarkdown` grammar, so the digest stays a pure function of the
// adopted markdown.
//
// CHARTER (2026-07-02 pruning pass, design §3): digests survive on
// `wiki/entities/**` ONLY. For each changed `.md` page under that scope:
// parse its claim lines, drop placeholder-shaped values (never render
// template scaffolding as fact), and when the remaining count is at or above
// `current_facts_min_claims` (default 3), render the digest — capped at
// `CURRENT_FACTS_CAP` (12) bullets, most-recent-`asOf`-first, with a
// `+N more — dome query <subject>` tail when capped — and splice it in after
// the frontmatter and the first `# ` H1 (so it reads as a fact header). A
// page OUTSIDE `wiki/entities/**` is never desired regardless of claim count:
// when it carries a stale block and is touched again, the existing
// splice-out branch removes it. Matching desired state yields zero effects —
// idempotent.
//
// LOAD-BEARING: the rendered block NEVER uses `**Key:**` claim grammar. It
// renders `- **Key** — value` (bold key WITHOUT the colon), so the digest can
// never be re-parsed as a claim and fed back into the claim index. The
// claim grammar's generated-block exclusion (claims-shared) is a second line
// of defense; this format is the first.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  findGeneratedBlock,
  generatedBlockMarkers,
  replaceGeneratedBlock,
} from "../../../../src/core/generated-block";
import { generatedBlockAnomalyDiagnostics } from "../../../../src/core/generated-block-diagnostics";
import {
  defineProcessorImplementation,
  type ExtensionConfig,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { AS_OF_MARKER_RE } from "./claim-fact";
import {
  claimsWithStableAnchors,
  type ClaimLine,
} from "./claims-shared";

const OWNER = "dome.claims";
const BLOCK = "current-facts";
const HEADING = "## Current facts";
const ANOMALY_CODE = "dome.claims.generated-block-anomaly";
const DEFAULT_MIN_CLAIMS = 3;

/** Digest scope: entity pages only (design §3, the "external-only" charter
 * revised to entities-only in scouting — see docs/wiki/specs/claims.md
 * §render-facts charter for the full rationale). */
const ENTITY_SCOPE_PREFIX = "wiki/entities/";

/** Bullet cap: most-recent-`asOf`-first, with a `+N more` tail past this
 * (the To-decide cap pattern; see dome.daily's `edition-blocks.ts`
 * `questionsSection`). */
export const CURRENT_FACTS_CAP = 12;

// The inline `*(as of YYYY-MM-DD)*` marker is stripped GLOBALLY and
// position-independently (shared `AS_OF_MARKER_RE` from ./claim-fact) so the
// dated suffix can be re-appended exactly once. A trailing anchor (`^c…`) is
// already removed by claims-shared, but the canonical superseded claim (sweep
// charter) leaves the marker MID-value with a `[[wikilink]]` AFTER it (e.g.
// `Active *(as of 2026-06-12)* [[meta/sources/x]]`). A trailing-anchored regex
// would miss that and re-append the date a second time — the Phase A
// doubled-date bug, reachable via the normal supersession path. Stripping every
// marker, wherever it sits, fixes it; the leftover whitespace is collapsed by
// the caller. The shared regex keeps this in lockstep with the decode-side
// strip in parseClaimFact.

// ----- Pure scope/filter/cap helpers -----------------------------------------

/** True when a page is in the digest's charter scope: `wiki/entities/**` only. */
export function isEntityScopedPage(path: string): boolean {
  return path.startsWith(ENTITY_SCOPE_PREFIX);
}

/**
 * True when a claim's value is template-shaped placeholder text — the whole
 * value (after peeling off any inline as-of marker) is wrapped in a single
 * `[`…`]` bracket pair, e.g. `[Specific incident — fill in or drop]`. A
 * `[[wikilink]]` (double brackets) is real content, not a placeholder, so it
 * is explicitly excluded. Placeholder-shaped claims never render in the
 * digest — the audit's laundering complaint.
 */
export function isPlaceholderValue(value: string): boolean {
  const stripped = value.replace(AS_OF_MARKER_RE, "").trim();
  if (!stripped.startsWith("[") || !stripped.endsWith("]")) return false;
  if (stripped.startsWith("[[") || stripped.endsWith("]]")) return false;
  return true;
}

/** Drop placeholder-shaped claims, preserving the remaining document order. */
export function filterPlaceholderClaims(
  claims: ReadonlyArray<ClaimLine>,
): ReadonlyArray<ClaimLine> {
  return Object.freeze(claims.filter((claim) => !isPlaceholderValue(claim.value)));
}

/**
 * Most-recent-`asOf`-first. Claims with no `asOf` sort last (they cannot be
 * "most recent"); ties (including all-null) keep document order via a
 * stable sort.
 */
export function sortByAsOfDesc(
  claims: ReadonlyArray<ClaimLine>,
): ReadonlyArray<ClaimLine> {
  return Object.freeze(
    [...claims].sort((a, b) => {
      if (a.asOf === b.asOf) return 0;
      if (a.asOf === null) return 1;
      if (b.asOf === null) return -1;
      return a.asOf < b.asOf ? 1 : -1;
    }),
  );
}

export type DigestSelection = {
  readonly shown: ReadonlyArray<ClaimLine>;
  readonly moreCount: number;
};

/** Sort most-recent-first, then cap to `cap` bullets; the remainder count
 * drives the `+N more` tail. */
export function selectDigestClaims(
  claims: ReadonlyArray<ClaimLine>,
  cap: number = CURRENT_FACTS_CAP,
): DigestSelection {
  const sorted = sortByAsOfDesc(claims);
  return Object.freeze({
    shown: Object.freeze(sorted.slice(0, cap)),
    moreCount: Math.max(0, sorted.length - cap),
  });
}

/** The `dome query <subject>` tail's subject: the page's own name (last path
 * segment, no directories) — the entity IS the subject of its own digest. */
export function digestSubject(page: string): string {
  const segments = page.split("/");
  return segments[segments.length - 1] ?? page;
}

// ----- Pure renderers --------------------------------------------------------

/**
 * Render the digest body: one bullet per claim, most-recent-`asOf`-first,
 * capped at `CURRENT_FACTS_CAP` with a `+N more — \`dome query <subject>\``
 * tail line when capped (the To-decide cap pattern). Placeholder-shaped
 * claims are dropped before sorting/capping — they never render. Each bullet
 * is `- **Key** — value *(as of …)*? ([[page#^anchor]])?`. `cleanValue` strips
 * every inline as-of marker (wherever it sits) and collapses whitespace, then
 * the dated suffix is re-appended from `claim.asOf` so the date appears exactly
 * once — even for the sweep's mid-value marker + trailing wikilink shape.
 * BOLD KEY WITHOUT COLON, never `**Key:**`.
 */
export function renderCurrentFactsBody(
  claims: ReadonlyArray<ClaimLine>,
  page: string,
): string {
  const { shown, moreCount } = selectDigestClaims(filterPlaceholderClaims(claims));
  const lines = shown.map((claim) => {
    const cleanValue = claim.value
      .replace(AS_OF_MARKER_RE, "")
      .replace(/\s+/g, " ")
      .trim();
    const asOf = claim.asOf === null ? "" : ` *(as of ${claim.asOf})*`;
    const anchor = claim.anchor === null ? "" : ` ([[${page}#^${claim.anchor}]])`;
    return `- **${claim.key}** — ${cleanValue}${asOf}${anchor}`;
  });
  if (moreCount > 0) {
    lines.push(`- +${moreCount} more — \`dome query ${digestSubject(page)}\``);
  }
  return lines.join("\n");
}

/**
 * Wrap the body in the dome.claims:current-facts markers with the
 * `## Current facts` heading as the first body line — INSIDE the block, so a
 * later splice-out removes the heading cleanly along with the markers.
 */
export function renderCurrentFactsBlock(
  claims: ReadonlyArray<ClaimLine>,
  page: string,
): string {
  const markers = generatedBlockMarkers(OWNER, BLOCK);
  const body = renderCurrentFactsBody(claims, page);
  return `${markers.start}\n${HEADING}\n\n${body}\n${markers.end}`;
}

// ----- Config resolution (degrade-not-crash) ---------------------------------

function minClaimsFromConfig(config?: ExtensionConfig): number {
  const raw = config?.["current_facts_min_claims"];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return DEFAULT_MIN_CLAIMS;
  }
  return raw;
}

// ----- Placement -------------------------------------------------------------

/**
 * Insertion offset for a fresh block: after the leading `---`…`---`
 * frontmatter (when present), then after an immediately-following first `# `
 * H1 line (when present). Returns a char offset just past the consumed
 * region's trailing newline (or content length when it runs to EOF).
 */
export function insertionOffset(content: string): number {
  const lines = content.split("\n");
  let cursor = 0; // 0-based line index of the next unconsumed line

  // Frontmatter: a leading `---` line closed by the next `---` line.
  if ((lines[0] ?? "").trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      if ((lines[i] ?? "").trim() === "---") {
        cursor = i + 1;
        break;
      }
    }
  }

  // Skip blank lines between frontmatter and the H1.
  let probe = cursor;
  while (probe < lines.length && (lines[probe] ?? "").trim() === "") probe += 1;
  // First H1 immediately following.
  if (probe < lines.length && /^#\s+\S/.test(lines[probe] ?? "")) {
    cursor = probe + 1;
  }

  // Convert the line cursor to a char offset.
  let offset = 0;
  for (let i = 0; i < cursor && i < lines.length; i += 1) {
    offset += (lines[i] as string).length + 1; // +1 for the split newline
  }
  return Math.min(offset, content.length);
}

/**
 * Splice a fresh block in at `offset` with surrounding blank lines, tidied.
 * Accepted limitation: the spliced region uses LF line endings even if the
 * surrounding document mixes CRLF.
 */
export function insertBlock(content: string, block: string, offset: number): string {
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  const head = before.replace(/\n+$/, "");
  const tail = after.replace(/^\n+/, "");
  const parts = [head, block, tail].filter((part) => part.length > 0);
  const joined = parts.join("\n\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/** Remove a block (already located) and tidy the doubled blank lines it left. */
function removeBlockAt(content: string, start: number, end: number): string {
  const before = content.slice(0, start).replace(/\n+$/, "");
  const after = content.slice(end).replace(/^\n+/, "");
  const parts = [before, after].filter((part) => part.length > 0);
  const joined = parts.join("\n\n");
  if (joined.length === 0) return "";
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

// ----- Processor -------------------------------------------------------------

const renderFacts = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const minClaims = minClaimsFromConfig(ctx.extensionConfig);

    const effects: Effect[] = [];
    const changes: FileChangeInput[] = [];

    for (const path of ctx.changedPaths) {
      if (!path.endsWith(".md")) continue;
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      // Surface marker anomalies regardless of the desired/has decision: a
      // half-open or smuggled marker should leave a trace even when no patch
      // lands (mirrors render-index's splice-guard posture).
      effects.push(
        ...generatedBlockAnomalyDiagnostics({
          content,
          path,
          code: ANOMALY_CODE,
          blocks: [{ owner: OWNER, block: BLOCK }],
          sourceRef: (refPath, range) => ctx.sourceRef(refPath, range),
        }),
      );

      const claims = claimsWithStableAnchors({ path, content });
      // Scope guard (design §3): a page outside wiki/entities/** is NEVER
      // desired, regardless of claim count — its digest (if any) is stale
      // scaffolding from before the recharter and gets spliced OUT below via
      // the existing removal branch. Placeholder-shaped claims (the audit's
      // laundering complaint) are excluded from the threshold count too, so
      // a page whose only claims are unfilled template text never renders an
      // empty-looking digest.
      const renderableCount = filterPlaceholderClaims(claims).length;
      const desired = isEntityScopedPage(path) && renderableCount >= minClaims;
      const { range } = findGeneratedBlock(content, OWNER, BLOCK);
      // The page name in wikilinks drops the `.md` extension (Obsidian style).
      const page = path.replace(/\.md$/, "");

      let next: string | null = null;
      if (desired && range !== null) {
        const block = renderCurrentFactsBlock(claims, page);
        next = replaceGeneratedBlock(content, OWNER, BLOCK, block);
      } else if (desired && range === null) {
        const block = renderCurrentFactsBlock(claims, page);
        next = insertBlock(content, block, insertionOffset(content));
      } else if (!desired && range !== null) {
        const spliced = removeBlockAt(content, range.start, range.end);
        // CONSCIOUS GUARD: removeBlockAt returns "" when the page was nothing
        // but the block. A real content page is never block-only (the block is
        // always spliced after frontmatter/H1), so this is practically
        // unreachable — but rather than write an empty file (data loss) or
        // delete the note (riskier still), we emit NO change for this page and
        // leave it as-is. A whitespace-only result is treated the same.
        next = spliced.trim().length === 0 ? null : spliced;
      }
      // !desired && absent → nothing.

      if (next === null || next === content) continue;
      changes.push({ kind: "write", path, content: next });
    }

    if (changes.length === 0) return Object.freeze(effects);
    return Object.freeze([
      ...effects,
      patchEffect({
        mode: "auto",
        changes,
        reason: "dome.claims: render Current facts digest",
        sourceRefs: changes.map((change) =>
          ctx.sourceRef(String(change.path), { startLine: 1, endLine: 1 }),
        ),
      }),
    ]);
  },
});

export default renderFacts;
