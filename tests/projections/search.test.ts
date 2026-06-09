// src/projections/search.ts — section-granular FTS row identity + reads.
//
// Per [[wiki/specs/projection-store]] §"fts_documents": the logical row
// identity is the (path, section_id) composite key maintained by the sink;
// a page delete clears every row for the path; replaying the indexer's
// delete-then-upsert sequence converges (idempotent re-index); reads carry
// sectionId/breadcrumb and documentsByPath returns one row per path.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  searchDocumentEffect,
  type SearchDocumentEffect,
} from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import {
  applySearchDocumentEffect,
  documentsByPath,
  searchDocuments,
} from "../../src/projections/search";

const ADOPTED = commitOid("abcdef0000000000000000000000000000000000");
const REF = sourceRef({ commit: ADOPTED, path: "wiki/alpha.md" });

let root: string;
let db: ProjectionDb;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dome-projection-search-"));
  const r = await openProjectionDb({
    path: join(root, ".dome", "state", "projection.db"),
    extensionSet: [],
    processorVersions: [],
    capabilityPolicyHash: "test-policy",
  });
  if (!r.ok) throw new Error(`openProjectionDb failed: ${JSON.stringify(r.error)}`);
  db = r.value.db;
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(root, { recursive: true, force: true });
});

function apply(effect: SearchDocumentEffect): void {
  applySearchDocumentEffect(db, { effect, adoptedCommit: ADOPTED });
}

function sectionUpsert(input: {
  readonly path?: string;
  readonly sectionId: string;
  readonly breadcrumb: string;
  readonly body: string;
}): SearchDocumentEffect {
  return searchDocumentEffect({
    operation: "upsert",
    path: input.path ?? "wiki/alpha.md",
    sectionId: input.sectionId,
    breadcrumb: input.breadcrumb,
    category: "wiki",
    title: "Project Alpha",
    body: `${input.breadcrumb}\n\n${input.body}`,
    sourceRefs: [REF],
  });
}

function indexAlphaSections(): void {
  apply(searchDocumentEffect({
    operation: "delete",
    path: "wiki/alpha.md",
    sourceRefs: [REF],
  }));
  apply(sectionUpsert({
    sectionId: "intro",
    breadcrumb: "Project Alpha",
    body: "Intro prose about the launch.",
  }));
  apply(sectionUpsert({
    sectionId: "rollout-plan",
    breadcrumb: "Project Alpha › Rollout Plan",
    body: "Phase one ships the flux capacitor.",
  }));
}

describe("section-granular fts_documents identity", () => {
  it("keeps one row per (path, sectionId) and replays idempotently", () => {
    indexAlphaSections();
    indexAlphaSections(); // re-index of unchanged content converges
    const rows = db.raw
      .query<{ path: string; section_id: string | null }, []>(
        "SELECT path, section_id FROM fts_documents ORDER BY section_id",
      )
      .all();
    expect(rows).toEqual([
      { path: "wiki/alpha.md", section_id: "intro" },
      { path: "wiki/alpha.md", section_id: "rollout-plan" },
    ]);
  });

  it("page delete clears every section row, so removed sections cannot linger", () => {
    indexAlphaSections();
    apply(searchDocumentEffect({
      operation: "delete",
      path: "wiki/alpha.md",
      sourceRefs: [REF],
    }));
    apply(sectionUpsert({
      sectionId: "intro",
      breadcrumb: "Project Alpha",
      body: "Rewritten intro without a rollout section.",
    }));
    const rows = db.raw
      .query<{ section_id: string | null }, []>(
        "SELECT section_id FROM fts_documents",
      )
      .all();
    expect(rows).toEqual([{ section_id: "intro" }]);
  });

  it("a sectioned upsert replaces its own section and any stale page-level row", () => {
    apply(searchDocumentEffect({
      operation: "upsert",
      path: "wiki/alpha.md",
      category: "wiki",
      title: "Project Alpha",
      body: "legacy page-level row",
      sourceRefs: [REF],
    }));
    apply(sectionUpsert({
      sectionId: "intro",
      breadcrumb: "Project Alpha",
      body: "sectioned row",
    }));
    apply(sectionUpsert({
      sectionId: "intro",
      breadcrumb: "Project Alpha",
      body: "sectioned row v2",
    }));
    const rows = db.raw
      .query<{ section_id: string | null; body: string }, []>(
        "SELECT section_id, body FROM fts_documents",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.section_id).toBe("intro");
    expect(rows[0]?.body).toContain("sectioned row v2");
  });

  it("a page-level upsert replaces every section row (legacy semantics)", () => {
    indexAlphaSections();
    apply(searchDocumentEffect({
      operation: "upsert",
      path: "wiki/alpha.md",
      category: "wiki",
      title: "Project Alpha",
      body: "page-level replacement",
      sourceRefs: [REF],
    }));
    const rows = db.raw
      .query<{ section_id: string | null }, []>(
        "SELECT section_id FROM fts_documents",
      )
      .all();
    expect(rows).toEqual([{ section_id: null }]);
  });
});

describe("section-granular reads", () => {
  it("searchDocuments returns section rows with sectionId + breadcrumb", () => {
    indexAlphaSections();
    const results = searchDocuments(db, { query: "flux capacitor" });
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("wiki/alpha.md");
    expect(results[0]?.sectionId).toBe("rollout-plan");
    expect(results[0]?.breadcrumb).toBe("Project Alpha › Rollout Plan");
  });

  it("breadcrumb terms match because the breadcrumb is in the indexed body", () => {
    indexAlphaSections();
    const results = searchDocuments(db, { query: "rollout plan" });
    expect(results.map((r) => r.sectionId)).toContain("rollout-plan");
  });

  it("documentsByPath returns one row per path (the intro section)", () => {
    indexAlphaSections();
    const results = documentsByPath(db, ["wiki/alpha.md", "wiki/alpha.md"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.sectionId).toBe("intro");
    // The breadcrumb prefix is stripped back out of the derived snippet.
    expect(results[0]?.snippet).toBe("Intro prose about the launch.");
  });
});
