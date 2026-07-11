import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchDocumentEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { RECALL_V1_CORPUS } from "../../src/eval/corpora/recall-v1";
import { scoreRecallCorpus, type RecallCorpus } from "../../src/eval/recall-quality";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import { applySearchDocumentEffect, searchDocuments } from "../../src/projections/search";

const ADOPTED = commitOid("a".repeat(40));
let root: string | null = null;
let db: ProjectionDb | null = null;

afterEach(() => {
  db?.close();
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
  db = null;
});

describe("recall product-quality gate", () => {
  test("scores recall, all-target success, reciprocal rank, and forbidden noise", () => {
    const corpus: RecallCorpus = {
      schema: "dome.eval.recall-corpus/v1",
      version: "test",
      documents: [],
      floors: { relevantRecallAt5: 0.5, allTargetsSuccessAt5: 0.5, maxForbiddenHitsAt10: 0 },
      queries: [
        { id: "a", job: "people", question: "a", relevantPaths: ["a", "b"] },
        { id: "b", job: "project-state", question: "b", relevantPaths: ["c"], forbiddenPaths: ["noise"] },
      ],
    };
    const report = scoreRecallCorpus(corpus, (query) =>
      query.id === "a" ? [{ path: "x" }, { path: "a" }, { path: "b" }] : [{ path: "c" }]
    );
    expect(report.relevantRecallAt5).toBe(1);
    expect(report.allTargetsSuccessAt5).toBe(1);
    expect(report.meanReciprocalRankAt5).toBe(0.75);
    expect(report.forbiddenHitsAt10).toBe(0);
    expect(report.passed).toBe(true);
  });

  test("corpus is versioned, referentially sound, and covers 30 work-shaped queries", () => {
    expect(RECALL_V1_CORPUS.schema).toBe("dome.eval.recall-corpus/v1");
    expect(RECALL_V1_CORPUS.queries.length).toBeGreaterThanOrEqual(30);
    expect(RECALL_V1_CORPUS.queries.length).toBeLessThanOrEqual(50);
    expect(new Set(RECALL_V1_CORPUS.queries.map((query) => query.id)).size)
      .toBe(RECALL_V1_CORPUS.queries.length);
    const paths = new Set(RECALL_V1_CORPUS.documents.map((document) => document.path));
    for (const query of RECALL_V1_CORPUS.queries) {
      expect(query.relevantPaths.length).toBeGreaterThan(0);
      for (const path of [...query.relevantPaths, ...(query.forbiddenPaths ?? [])]) {
        expect(paths.has(path)).toBe(true);
      }
    }
    expect(new Set(RECALL_V1_CORPUS.queries.map((query) => query.job))).toEqual(new Set([
      "people", "decision-provenance", "meeting-prep", "project-state", "cross-page-synthesis",
    ]));
  });

  test("current lexical retrieval stays above the checked-in floors", async () => {
    root = mkdtempSync(join(tmpdir(), "dome-recall-quality-"));
    const opened = await openProjectionDb({
      path: join(root, ".dome", "state", "projection.db"),
      extensionSet: [], processorVersions: [], capabilityPolicyHash: "eval",
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    db = opened.value.db;
    for (const document of RECALL_V1_CORPUS.documents) {
      applySearchDocumentEffect(db, {
        adoptedCommit: ADOPTED,
        effect: searchDocumentEffect({
          operation: "upsert",
          path: document.path,
          category: document.category,
          ...(document.type === undefined ? {} : { type: document.type }),
          title: document.title,
          body: document.body,
          sourceRefs: [sourceRef({ commit: ADOPTED, path: document.path })],
        }),
      });
    }
    const report = scoreRecallCorpus(RECALL_V1_CORPUS, (query, limit) =>
      searchDocuments(db!, { query: query.question, limit })
    );
    expect(report, JSON.stringify(report.failures, null, 2)).toMatchObject({ passed: true });
  });
});
