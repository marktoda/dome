// The semantic-gardening module. It compiles adopted markdown into a small,
// evidence-backed plan; it does not read the filesystem, call a model, or
// mutate state. The nightly garden processor and the on-demand `garden` view
// are thin adapters over this one interface.

import { compareStrings } from "../../../../src/core/compare";
import { shortHash } from "../../../../src/core/short-hash";

export const GARDEN_SCHEMA = "dome.agent.garden/v1";
export const GARDEN_REASON_PREFIX = "dome.agent.garden opportunity ";
export const DEFAULT_GARDEN_TARGETS: ReadonlyArray<string> = Object.freeze([
  "wiki/entities/",
  "wiki/concepts/",
  "wiki/syntheses/",
]);
export const DEFAULT_GARDEN_LIMIT = 5;
export const DEFAULT_STALE_CLAIM_DAYS = 120;
export const OVERSIZED_LINES = 600;
export const MAX_MATERIAL_DESTINATIONS = 8;

export type GardenDocument = {
  readonly path: string;
  readonly content: string;
};

/** Private implementation vocabulary for dome.agent, not plugin categories. */
export type GardeningOpportunityKind =
  | "integrate-material"
  | "possible-duplicate"
  | "conflicting-claims"
  | "stale-claims"
  | "oversized-page"
  | "orphan-page"
  | "rotation-review";

export type GardeningOpportunity = {
  readonly id: string;
  readonly kind: GardeningOpportunityKind;
  readonly priority: number;
  readonly summary: string;
  readonly paths: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
};

export type GardeningPlan = {
  readonly schema: typeof GARDEN_SCHEMA;
  readonly asOfDate: string;
  readonly totalSemanticPages: number;
  readonly totalOpportunities: number;
  readonly counts: Readonly<Record<GardeningOpportunityKind, number>>;
  readonly opportunities: ReadonlyArray<GardeningOpportunity>;
};

export type GardeningProposalSummary = {
  readonly processorId: string;
  readonly reason: string;
};

/** Recover exact opportunity identities from durable garden proposal rows. */
export function settledGardeningOpportunityIds(
  proposals: ReadonlyArray<GardeningProposalSummary>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const proposal of proposals) {
    if (proposal.processorId !== "dome.agent.garden") continue;
    const start = proposal.reason.indexOf(GARDEN_REASON_PREFIX);
    if (start < 0) continue;
    const rest = proposal.reason.slice(start + GARDEN_REASON_PREFIX.length);
    const id = /^([a-z-]+:[a-f0-9]{12})/.exec(rest)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

type ParsedPage = GardenDocument & {
  readonly title: string;
  readonly description: string;
  readonly status: string | null;
  readonly fingerprint: string;
  readonly titleTokens: ReadonlySet<string>;
  readonly semanticTokens: ReadonlySet<string>;
  readonly links: ReadonlySet<string>;
  readonly claims: ReadonlyArray<ParsedClaim>;
  readonly lineCount: number;
};

type ParsedClaim = {
  readonly key: string;
  readonly value: string;
  readonly asOf: string | null;
};

const EMPTY_COUNTS: Record<GardeningOpportunityKind, number> = {
  "integrate-material": 0,
  "possible-duplicate": 0,
  "conflicting-claims": 0,
  "stale-claims": 0,
  "oversized-page": 0,
  "orphan-page": 0,
  "rotation-review": 0,
};

/**
 * Compile current markdown into a bounded nightly working set. The complete
 * opportunity count remains in the result, so the same result is both the
 * executor input and the product's coherence instrument.
 */
export function compileGardeningPlan(opts: {
  readonly documents: ReadonlyArray<GardenDocument>;
  readonly today: string;
  readonly targets?: ReadonlyArray<string>;
  readonly limit?: number;
  readonly staleClaimDays?: number;
  /** Opportunity ids already represented by a durable proposal decision. */
  readonly settledOpportunityIds?: ReadonlySet<string>;
}): GardeningPlan {
  const targets = opts.targets ?? DEFAULT_GARDEN_TARGETS;
  const limit = Math.max(0, opts.limit ?? DEFAULT_GARDEN_LIMIT);
  const horizon = opts.staleClaimDays ?? DEFAULT_STALE_CLAIM_DAYS;
  const parsed = opts.documents.map(parsePage);
  const semantic = parsed.filter(
    (page) =>
      targets.some((prefix) => page.path.startsWith(prefix)) &&
      page.status !== "superseded",
  );
  const opportunities: GardeningOpportunity[] = [];

  for (const page of semantic) {
    if (page.lineCount > OVERSIZED_LINES) {
      opportunities.push(opportunity({
        kind: "oversized-page",
        priority: 900 + Math.min(99, page.lineCount - OVERSIZED_LINES),
        summary: `${page.path} has accreted to ${page.lineCount} lines`,
        paths: [page.path],
        evidence: [`${page.lineCount} lines; split threshold is ${OVERSIZED_LINES}`],
        identityEvidence: [page.fingerprint],
      }));
    }

    const stale = page.claims.filter((claim) => {
      if (claim.asOf === null) return false;
      return daysBetween(claim.asOf, opts.today) > horizon;
    });
    if (stale.length > 0) {
      opportunities.push(opportunity({
        kind: "stale-claims",
        priority: 720 + Math.min(99, stale.length),
        summary: `${page.path} has ${stale.length} dated claim${stale.length === 1 ? "" : "s"} beyond the ${horizon}-day horizon`,
        paths: [page.path],
        evidence: stale.slice(0, 5).map((claim) =>
          `${claim.key}: ${claim.value} (as of ${claim.asOf})`
        ),
        identityEvidence: [page.fingerprint],
      }));
    }
  }

  for (let i = 0; i < semantic.length; i += 1) {
    for (let j = i + 1; j < semantic.length; j += 1) {
      const left = semantic[i]!;
      const right = semantic[j]!;
      const similarity = pageSimilarity(left, right);
      const titleSimilarity = setSimilarity(left.titleTokens, right.titleTokens);
      if (similarity < 0.72 || titleSimilarity < 0.8) continue;
      const conflicts = conflictingClaims(left.claims, right.claims);
      opportunities.push(opportunity({
        kind: conflicts.length > 0 ? "conflicting-claims" : "possible-duplicate",
        priority: conflicts.length > 0 ? 880 : 780,
        summary: conflicts.length > 0
          ? `${left.path} and ${right.path} describe a similar subject but disagree on ${conflicts.length} claim key${conflicts.length === 1 ? "" : "s"}`
          : `${left.path} and ${right.path} may be duplicate or overlapping pages`,
        paths: [left.path, right.path],
        evidence: conflicts.length > 0
          ? conflicts.slice(0, 5)
          : [
              `title/description token similarity ${similarity.toFixed(2)}`,
              `${left.path}: ${left.description}`,
              `${right.path}: ${right.description}`,
            ],
        identityEvidence: [left.fingerprint, right.fingerprint],
      }));
    }
  }

  const incoming = incomingLinkCounts(semantic, parsed);
  for (const page of semantic) {
    if ((incoming.get(page.path) ?? 0) > 0) continue;
    opportunities.push(opportunity({
      kind: "orphan-page",
      priority: 560,
      summary: `${page.path} has no incoming wikilinks`,
      paths: [page.path],
      evidence: [
        "No readable markdown page links to this page by full path or unique basename",
        `Description: ${page.description}`,
      ],
      identityEvidence: [page.fingerprint],
    }));
  }

  opportunities.push(...materialOpportunities(parsed, semantic, opts.today));

  // Stateless coverage: a date-salted rotation chooses a small tail even when
  // no heuristic fires. Proposal dedupe is the memory; no patrol ledger or
  // queue is needed. Pages with stronger evidence are not added again.
  const alreadyCovered = new Set(opportunities.flatMap((item) => item.paths));
  const rotation = semantic
    .filter((page) => !alreadyCovered.has(page.path))
    .sort((a, b) => {
      const ar = rotationRank(a.path, opts.today);
      const br = rotationRank(b.path, opts.today);
      return ar !== br ? ar - br : compareStrings(a.path, b.path);
    })
    .slice(0, 2);
  for (const page of rotation) {
    opportunities.push(opportunity({
      kind: "rotation-review",
      priority: 100,
      summary: `Routine coherence review for ${page.path}`,
      paths: [page.path],
      evidence: [
        "Selected by the stateless content-and-date coverage rotation",
      ],
      identityEvidence: [page.fingerprint],
    }));
  }

  const ordered = dedupeOpportunities(opportunities)
    .filter((item) => !(opts.settledOpportunityIds?.has(item.id) ?? false))
    .sort((a, b) =>
    b.priority !== a.priority
      ? b.priority - a.priority
      : compareStrings(a.id, b.id)
  );
  const counts = { ...EMPTY_COUNTS };
  for (const item of ordered) counts[item.kind] += 1;

  return Object.freeze({
    schema: GARDEN_SCHEMA,
    asOfDate: opts.today,
    totalSemanticPages: semantic.length,
    totalOpportunities: ordered.length,
    counts: Object.freeze(counts),
    opportunities: Object.freeze(ordered.slice(0, limit)),
  });
}

function parsePage(document: GardenDocument): ParsedPage {
  const description = /^description:\s*(.+?)\s*$/m.exec(document.content)?.[1]?.replace(/^['"]|['"]$/g, "") ?? "";
  const status = /^status:\s*(.+?)\s*$/m.exec(document.content)?.[1]?.trim().toLowerCase() ?? null;
  return {
    ...document,
    title: document.path.split("/").pop()?.replace(/\.md$/, "").replace(/[-_]/g, " ") ?? document.path,
    description,
    status,
    fingerprint: shortHash(document.content, 12),
    titleTokens: tokens(document.path.split("/").pop()?.replace(/\.md$/, "").replace(/[-_]/g, " ") ?? document.path),
    semanticTokens: tokens(`${document.path.split("/").pop()?.replace(/\.md$/, "").replace(/[-_]/g, " ") ?? document.path} ${description}`),
    links: extractLinks(document.content),
    claims: extractClaims(document.content),
    lineCount: countLines(document.content),
  };
}

function extractLinks(content: string): ReadonlySet<string> {
  const links = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  for (const match of content.matchAll(re)) {
    const raw = match[1]?.trim();
    if (raw) links.add(raw.replace(/\.md$/, ""));
  }
  return links;
}

function extractClaims(content: string): ReadonlyArray<ParsedClaim> {
  const claims: ParsedClaim[] = [];
  const re = /^\s*(?:[-*+]\s+)?\*\*([^*]+?):\*\*\s+(.+?)\s*(?:\^c[a-z0-9]+)?\s*$/gim;
  for (const match of content.matchAll(re)) {
    const rawValue = match[2] ?? "";
    const asOf = /\*\(as of (\d{4}-\d{2}-\d{2})\)\*/i.exec(rawValue)?.[1] ?? null;
    claims.push({
      key: normalizeWords(match[1] ?? ""),
      value: rawValue.replace(/\s*\*\(as of \d{4}-\d{2}-\d{2}\)\*/gi, "").trim(),
      asOf,
    });
  }
  return claims;
}

function conflictingClaims(
  left: ReadonlyArray<ParsedClaim>,
  right: ReadonlyArray<ParsedClaim>,
): ReadonlyArray<string> {
  const rightByKey = new Map(right.map((claim) => [claim.key, claim]));
  const conflicts: string[] = [];
  for (const claim of left) {
    const other = rightByKey.get(claim.key);
    if (other && normalizeWords(other.value) !== normalizeWords(claim.value)) {
      conflicts.push(`${claim.key}: “${claim.value}” vs “${other.value}”`);
    }
  }
  return conflicts;
}

function pageSimilarity(left: ParsedPage, right: ParsedPage): number {
  return setSimilarity(left.semanticTokens, right.semanticTokens);
}

function setSimilarity(
  leftTokens: ReadonlySet<string>,
  rightTokens: ReadonlySet<string>,
): number {
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function tokens(value: string): ReadonlySet<string> {
  return new Set(
    normalizeWords(value).split(" ").filter((word) =>
      word.length >= 3 && !/^\d+$/.test(word) && !STOP_WORDS.has(word)
    ),
  );
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "page", "notes",
  "profile", "overview", "synthesis", "incident", "load", "pod",
]);

function incomingLinkCounts(
  semantic: ReadonlyArray<ParsedPage>,
  all: ReadonlyArray<ParsedPage>,
): ReadonlyMap<string, number> {
  const counts = new Map(semantic.map((page) => [page.path, 0]));
  const byBase = new Map<string, string[]>();
  for (const page of semantic) {
    const base = withoutMd(page.path).split("/").pop()!;
    byBase.set(base, [...(byBase.get(base) ?? []), page.path]);
  }
  for (const source of all) {
    for (const link of source.links) {
      const full = `${link}.md`;
      if (counts.has(full) && full !== source.path) {
        counts.set(full, (counts.get(full) ?? 0) + 1);
        continue;
      }
      const matches = byBase.get(link);
      if (matches?.length === 1 && matches[0] !== source.path) {
        const target = matches[0]!;
        counts.set(target, (counts.get(target) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function materialOpportunities(
  all: ReadonlyArray<ParsedPage>,
  semantic: ReadonlyArray<ParsedPage>,
  today: string,
): ReadonlyArray<GardeningOpportunity> {
  const result: GardeningOpportunity[] = [];
  for (const material of all) {
    const date = materialDate(material.path);
    if (date === null || date >= today || daysBetween(date, today) > 14) continue;
    const destinations = semantic
      .filter((destination) =>
        mentionsPage(material, destination) &&
        !sourcesContain(destination.content, material.path)
      )
      .sort((a, b) => compareStrings(a.path, b.path));
    for (let offset = 0; offset < destinations.length; offset += MAX_MATERIAL_DESTINATIONS) {
      const chunk = destinations.slice(offset, offset + MAX_MATERIAL_DESTINATIONS);
      result.push(opportunity({
        kind: "integrate-material",
        priority: 834 - daysBetween(date, today),
        summary: `${material.path} may contain durable information for ${chunk.length} semantic page${chunk.length === 1 ? "" : "s"}`,
        paths: [material.path, ...chunk.map((destination) => destination.path)],
        evidence: chunk.map((destination) =>
          `Explicitly links ${destination.path}; its sources do not cite this material`
        ),
        identityEvidence: [material.fingerprint, ...chunk.map((destination) => destination.fingerprint)],
      }));
    }
  }
  return result;
}

function materialDate(path: string): string | null {
  return /^wiki\/dailies\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1]
    ?? /^inbox\/processed\/(\d{4}-\d{2}-\d{2})/.exec(path)?.[1]
    ?? null;
}

function mentionsPage(material: ParsedPage, destination: ParsedPage): boolean {
  const target = withoutMd(destination.path);
  const base = target.split("/").pop()!;
  return material.links.has(target) || material.links.has(base);
}

function sourcesContain(content: string, materialPath: string): boolean {
  const frontmatter = /^\s*---\s*\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
  const target = withoutMd(materialPath);
  return frontmatter.includes(`[[${target}]]`) || frontmatter.includes(`[[${target}|`) || frontmatter.includes(`[[${target}.md]]`) || frontmatter.includes(`[[${target}.md|`);
}

type OpportunityInput = Omit<GardeningOpportunity, "id"> & {
  /** Current source-state identity that need not leak into product evidence. */
  readonly identityEvidence?: ReadonlyArray<string>;
};

function opportunity(input: OpportunityInput): GardeningOpportunity {
  const paths = [...input.paths].sort(compareStrings);
  const { identityEvidence = [], ...publicInput } = input;
  return Object.freeze({
    ...publicInput,
    // Evidence participates in identity. Rejecting a proposal settles the
    // exact observed state, while a changed claim/date/size re-arms review.
    id: `${input.kind}:${shortHash([...paths, ...input.evidence, ...identityEvidence].join("\n"), 12)}`,
    paths: Object.freeze(paths),
    evidence: Object.freeze([...input.evidence]),
  });
}

function dedupeOpportunities(items: ReadonlyArray<GardeningOpportunity>): GardeningOpportunity[] {
  const byId = new Map<string, GardeningOpportunity>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}

function normalizeWords(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function withoutMd(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function countLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function daysBetween(from: string, to: string): number {
  const delta = Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
  return Number.isFinite(delta) ? Math.floor(delta / 86_400_000) : 0;
}

function rotationRank(path: string, today: string): number {
  return Number.parseInt(shortHash(`${today}:${path}`, 8), 16);
}
