// dome.claims.render-facts — garden processor: compile a deterministic
// `## Current facts` digest block for claim-rich pages. Snapshot-in →
// patches-out: it reads page content off the snapshot (garden processors
// can't read the projection) and re-parses claim lines with the shared
// `claimsFromMarkdown` grammar, so the digest stays a pure function of the
// adopted markdown.
//
// For each changed `.md` page: parse its claim lines. When the count is at or
// above `current_facts_min_claims` (default 3), render the digest block and
// splice it in after the frontmatter and the first `# ` H1 (so it reads as a
// fact header). When the count is below threshold and a stale block exists,
// splice it OUT, preserving the surrounding prose. Matching desired state
// yields zero effects — idempotent.
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
import { claimsFromMarkdown, type ClaimLine } from "./claims-shared";

const OWNER = "dome.claims";
const BLOCK = "current-facts";
const HEADING = "## Current facts";
const ANOMALY_CODE = "dome.claims.generated-block-anomaly";
const DEFAULT_MIN_CLAIMS = 3;

/**
 * Strip a trailing inline `*(as of YYYY-MM-DD)*` marker from a claim value so
 * the dated suffix can be re-appended exactly once. Mirrors claims-shared's
 * AS_OF_RE; anchored to the end (with trailing whitespace tolerated) so only a
 * trailing marker is removed, never one embedded mid-value. Phase A hit a
 * doubled-date bug here.
 */
const TRAILING_AS_OF_RE = /\s*\*\(as of \d{4}-\d{2}-\d{2}\)\*\s*$/;

// ----- Pure renderers --------------------------------------------------------

/**
 * Render the digest body: one line per claim in document order,
 * `- **Key** — value *(as of …)*? ([[page#^anchor]])?`. `cleanValue` strips
 * any trailing inline as-of marker and collapses whitespace, then the dated
 * suffix is re-appended from `claim.asOf` so the date appears exactly once.
 * BOLD KEY WITHOUT COLON, never `**Key:**`.
 */
export function renderCurrentFactsBody(
  claims: ReadonlyArray<ClaimLine>,
  page: string,
): string {
  return claims
    .map((claim) => {
      const cleanValue = claim.value
        .replace(TRAILING_AS_OF_RE, "")
        .replace(/\s+/g, " ")
        .trim();
      const asOf = claim.asOf === null ? "" : ` *(as of ${claim.asOf})*`;
      const anchor = claim.anchor === null ? "" : ` ([[${page}#^${claim.anchor}]])`;
      return `- **${claim.key}** — ${cleanValue}${asOf}${anchor}`;
    })
    .join("\n");
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
function insertionOffset(content: string): number {
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

/** Splice a fresh block in at `offset` with surrounding blank lines, tidied. */
function insertBlock(content: string, block: string, offset: number): string {
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

      const claims = claimsFromMarkdown(content);
      const desired = claims.length >= minClaims;
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
        next = removeBlockAt(content, range.start, range.end);
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
