// dome.search.query / dome.search.export-context — candidate dedupe pin.
//
// The repro: an FTS hit beyond the top-10 link-expansion seeds that is ALSO
// linked from a top hit entered the candidate set twice — once through the
// FTS channel and once through the link-expansion channel — because the
// expansion filter only excluded recall-channel paths, not FTS paths. The
// page then rendered as a duplicate result row / context entry.

import { describe, expect, test } from "bun:test";

import exportContext from "../../assets/extensions/dome.search/processors/export-context";
import searchQuery, {
  factPriority,
} from "../../assets/extensions/dome.search/processors/query";
import { CLAIM_PREDICATE } from "../../assets/extensions/dome.claims/processors/claim-fact";
import type { Effect, FactEffect, ViewEffect } from "../../src/core/effect";
import {
  treeOid,
  type ProjectionQueryView,
  type SearchDocumentResult,
  type Snapshot,
} from "../../src/core/processor";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("6666666666666666666666666666666666666666");

// 12 FTS hits: page-01 .. page-12 (rank order). The link-expansion channel
// seeds from the top 10, so page-12 is NOT a seed — but page-01 links to it,
// so it enters the expansion channel while already being an FTS candidate.
const FTS_PATHS = Array.from(
  { length: 12 },
  (_, i) => `wiki/page-${String(i + 1).padStart(2, "0")}.md`,
);
const DUPLICATED_PATH = "wiki/page-12.md";

function doc(path: string, rank: number): SearchDocumentResult {
  return Object.freeze({
    path,
    sectionId: null,
    breadcrumb: null,
    category: "wiki",
    type: null,
    title: path,
    snippet: "alpha launch notes",
    rank,
    sourceRefs: Object.freeze([
      sourceRef({ commit: HEAD_COMMIT, path }),
    ]),
  });
}

const DOCS = FTS_PATHS.map((path, i) => doc(path, -10 + i));
const DOC_BY_PATH = new Map(DOCS.map((d) => [d.path, d]));

const LINKS_TO_FACT = Object.freeze({
  kind: "fact",
  subject: Object.freeze({ kind: "page", path: "wiki/page-01.md" }),
  predicate: "dome.graph.links_to",
  object: Object.freeze({ kind: "string", value: "page-12" }),
  assertion: "asserted",
  sourceRefs: Object.freeze([
    sourceRef({ commit: HEAD_COMMIT, path: "wiki/page-01.md" }),
  ]),
}) as unknown as FactEffect;

const projection: ProjectionQueryView = Object.freeze({
  facts: (filter?: { readonly predicate?: string }) =>
    filter?.predicate === "dome.graph.links_to"
      ? Object.freeze([LINKS_TO_FACT])
      : Object.freeze([]),
  diagnostics: () => Object.freeze([]),
  questions: () => Object.freeze([]),
  searchDocuments: () => Object.freeze(DOCS),
  documentsByPath: (paths: ReadonlyArray<string>) =>
    Object.freeze(
      paths
        .map((path) => DOC_BY_PATH.get(path))
        .filter((d): d is SearchDocumentResult => d !== undefined),
    ),
});

function runView(
  processor: { run: (ctx: never) => Promise<ReadonlyArray<Effect>> },
  input: unknown,
): Promise<ReadonlyArray<Effect>> {
  const snapshot: Snapshot = Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("7777777777777777777777777777777777777777"),
    readFile: async () => null,
    listMarkdownFiles: async () => Object.freeze(FTS_PATHS),
    getFileInfo: async () => null,
  });
  const ctx = makeProcessorContext({
    snapshot,
    changedPaths: Object.freeze([]),
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-search-dedupe-test",
    signal: new AbortController().signal,
    input,
    projection,
  });
  return processor.run(ctx as never);
}

function structuredData(effects: ReadonlyArray<Effect>): unknown {
  const view = effects.find((e): e is ViewEffect => e.kind === "view");
  if (view === undefined || view.content.kind !== "structured") {
    throw new Error("expected one structured ViewEffect");
  }
  return view.content.data;
}

describe("dome.search candidate dedupe (FTS hit linked from a top hit)", () => {
  test("dome query returns each page at most once", async () => {
    const effects = await runView(searchQuery, {
      text: "alpha launch",
      limit: 50,
    });
    const data = structuredData(effects) as {
      readonly matches: ReadonlyArray<{ readonly path: string }>;
    };
    const paths = data.matches.map((m) => m.path);
    expect(paths).toContain(DUPLICATED_PATH);
    expect(
      paths.filter((path) => path === DUPLICATED_PATH),
    ).toHaveLength(1);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("dome export-context returns each page at most once", async () => {
    const effects = await runView(exportContext, {
      topic: "alpha launch",
      limit: 25,
    });
    const data = structuredData(effects) as {
      readonly entries: ReadonlyArray<{ readonly path: string }>;
    };
    const paths = data.entries.map((entry) => entry.path);
    expect(paths).toContain(DUPLICATED_PATH);
    expect(
      paths.filter((path) => path === DUPLICATED_PATH),
    ).toHaveLength(1);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

function fact(predicate: string, value = "{}"): FactEffect {
  return {
    kind: "fact",
    subject: { kind: "page", path: "p.md" },
    predicate,
    object: { kind: "string", value },
    assertion: "extracted",
    sourceRefs: [],
  } as unknown as FactEffect;
}

describe("factPriority — claims", () => {
  test("claims rank above generic facts and graph facts", () => {
    const claim = factPriority(
      fact(CLAIM_PREDICATE, JSON.stringify({ key: "Status", value: "x" })),
    );
    expect(claim).toBeLessThan(factPriority(fact("dome.page.description")));
    expect(claim).toBeLessThan(factPriority(fact("dome.graph.links_to")));
  });

  test("claims sit in the decision tier, not merely above generic facts", () => {
    // isSearchDecisionFact keys purely on the dome.daily.decision predicate,
    // so a bare fact with that predicate is a decision for priority purposes.
    const claim = factPriority(
      fact(CLAIM_PREDICATE, JSON.stringify({ key: "Status", value: "x" })),
    );
    expect(claim).toBe(factPriority(fact("dome.daily.decision")));
  });
});
