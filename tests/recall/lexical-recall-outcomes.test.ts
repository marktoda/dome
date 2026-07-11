// Product-level lexical recall canaries derived from real failure shapes.
// These test the observable outcome—target page in the working set—not the
// internal FTS expression. New lexical retrieval work should add cases here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchDocumentEffect } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { openProjectionDb, type ProjectionDb } from "../../src/projections/db";
import {
  applySearchDocumentEffect,
  searchDocuments,
} from "../../src/projections/search";

const ADOPTED = commitOid("abcdef0000000000000000000000000000000000");

const DOCUMENTS = [
  {
    path: "wiki/entities/alice-chen.md",
    title: "Alice Chen",
    body: "Alice Chen received the promotion and now owns the platform organization.",
  },
  {
    path: "wiki/entities/maya-patel.md",
    title: "Maya Patel",
    body: "Maya's compensation review is scheduled for Friday. The remaining discussion concerns equity.",
  },
  {
    path: "wiki/projects/apollo.md",
    title: "Project Apollo",
    body: "The Apollo launch decision moved the release to October after the security review.",
  },
  {
    path: "wiki/meetings/weekly-open-items.md",
    title: "Weekly open items",
    body: "Open threads and general priorities for the weekly operations meeting.",
  },
  {
    path: "wiki/concepts/promotion-process.md",
    title: "Promotion process",
    body: "General promotion calibration guidance and review mechanics.",
  },
] as const;

let root: string;
let db: ProjectionDb;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dome-recall-outcomes-"));
  const opened = await openProjectionDb({
    path: join(root, ".dome", "state", "projection.db"),
    extensionSet: [],
    processorVersions: [],
    capabilityPolicyHash: "test-policy",
  });
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  db = opened.value.db;

  for (const document of DOCUMENTS) {
    applySearchDocumentEffect(db, {
      adoptedCommit: ADOPTED,
      effect: searchDocumentEffect({
        operation: "upsert",
        path: document.path,
        category: "wiki",
        ...(document.path.includes("/entities/") ? { type: "person" } : {}),
        title: document.title,
        body: document.body,
        sourceRefs: [sourceRef({ commit: ADOPTED, path: document.path })],
      }),
    });
  }
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("work-derived lexical recall outcomes", () => {
  const cases = [
    {
      question: "What was the outcome of Alice Chen's promotion?",
      target: "wiki/entities/alice-chen.md",
    },
    {
      question: "What are Maya's compensation priorities and open threads?",
      target: "wiki/entities/maya-patel.md",
    },
    {
      question: "What is the latest status and outcome for the Apollo launch?",
      target: "wiki/projects/apollo.md",
    },
  ] as const;

  for (const item of cases) {
    test(`recall@5 includes ${item.target} for: ${item.question}`, () => {
      const paths = searchDocuments(db, { query: item.question, limit: 5 })
        .map((match) => match.path);
      expect(paths).toContain(item.target);
    });
  }

  test("minimum-match excludes documents sharing only an answer-shape word", () => {
    const paths = searchDocuments(db, {
      query: "What are Maya's compensation priorities and open threads?",
      limit: 10,
    }).map((match) => match.path);
    expect(paths).toContain("wiki/entities/maya-patel.md");
    expect(paths).not.toContain("wiki/meetings/weekly-open-items.md");
  });
});
