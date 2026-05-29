import { describe, expect, test } from "bun:test";

import {
  diagnosticEffect,
  factEffect,
  nodeRef,
  questionEffect,
} from "../../src/core/effect";
import type { ProjectionQueryView } from "../../src/core/processor";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { scopeProjectionQueryView } from "../../src/processors/projection-scope";

const COMMIT = commitOid("abc0000000000000000000000000000000000000");
const PUBLIC_REF = sourceRef({ commit: COMMIT, path: "public/a.md" });
const SECRET_REF = sourceRef({ commit: COMMIT, path: "secret/a.md" });

const PUBLIC_FACT = factEffect({
  subject: nodeRef({ kind: "page", path: "public/a.md" }),
  predicate: "test.links_to",
  object: { kind: "string", value: "target" },
  assertion: "explicit",
  sourceRefs: [PUBLIC_REF],
});

const SECRET_FACT = factEffect({
  subject: nodeRef({ kind: "page", path: "secret/a.md" }),
  predicate: "test.links_to",
  object: { kind: "string", value: "target" },
  assertion: "explicit",
  sourceRefs: [SECRET_REF],
});

const PUBLIC_DIAGNOSTIC = diagnosticEffect({
  severity: "warning",
  code: "test.public",
  message: "public",
  sourceRefs: [PUBLIC_REF],
});

const SECRET_DIAGNOSTIC = diagnosticEffect({
  severity: "warning",
  code: "test.secret",
  message: "secret",
  sourceRefs: [SECRET_REF],
});

const GLOBAL_DIAGNOSTIC = diagnosticEffect({
  severity: "info",
  code: "test.global",
  message: "global",
  sourceRefs: [],
});

const PUBLIC_QUESTION = questionEffect({
  question: "public?",
  idempotencyKey: "public",
  sourceRefs: [PUBLIC_REF],
});

const SECRET_QUESTION = questionEffect({
  question: "secret?",
  idempotencyKey: "secret",
  sourceRefs: [SECRET_REF],
});

const projection: ProjectionQueryView = Object.freeze({
  facts: () => Object.freeze([PUBLIC_FACT, SECRET_FACT]),
  diagnostics: () =>
    Object.freeze([PUBLIC_DIAGNOSTIC, SECRET_DIAGNOSTIC, GLOBAL_DIAGNOSTIC]),
  questions: () => Object.freeze([PUBLIC_QUESTION, SECRET_QUESTION]),
  searchDocuments: () =>
    Object.freeze([
      {
        path: "public/a.md",
        category: "page",
        type: null,
        title: "public",
        snippet: "public",
        rank: 0,
        sourceRefs: [PUBLIC_REF],
      },
      {
        path: "secret/a.md",
        category: "page",
        type: null,
        title: "secret",
        snippet: "secret",
        rank: 1,
        sourceRefs: [SECRET_REF],
      },
    ]),
});

describe("scopeProjectionQueryView", () => {
  test("filters projection rows to paths visible through read grants", () => {
    const scoped = scopeProjectionQueryView(
      projection,
      (path) => path.startsWith("public/"),
    );

    expect(scoped.facts().map((fact) => fact.subject)).toEqual([
      nodeRef({ kind: "page", path: "public/a.md" }),
    ]);
    expect(scoped.diagnostics().map((diag) => diag.code)).toEqual([
      "test.public",
      "test.global",
    ]);
    expect(scoped.questions().map((question) => question.idempotencyKey)).toEqual([
      "public",
    ]);
    expect(scoped.searchDocuments({ query: "x" }).map((result) => result.path))
      .toEqual(["public/a.md"]);
  });
});
