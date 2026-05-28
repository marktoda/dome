// Smoke tests for src/engine/capability-broker.ts: the per-effect-kind cells
// of docs/wiki/matrices/effect-x-capability.md. Constructs effects via the
// public constructor helpers in src/core/effect.ts and asserts the broker's
// allow/downgrade/deny verdicts.

import { describe, test, expect } from "bun:test";
import { enforceCapability } from "../../src/engine/capability-broker";
import {
  diagnosticEffect,
  externalActionEffect,
  factEffect,
  jobEffect,
  patchEffect,
  questionEffect,
  viewEffect,
} from "../../src/core/effect";
import type { Capability } from "../../src/core/processor";
import { commitOid, sourceRef } from "../../src/core/source-ref";

const ref = sourceRef({ commit: commitOid("abc"), path: "wiki/x.md" });

const patchTouching = (path: string) =>
  patchEffect({
    mode: "auto",
    changes: [{ kind: "write", path, content: "x\n" }],
    reason: "test",
    sourceRefs: [ref],
  });

const patchTouchingMany = (paths: ReadonlyArray<string>) =>
  patchEffect({
    mode: "auto",
    changes: paths.map((path) => ({ kind: "write" as const, path, content: "x\n" })),
    reason: "test",
    sourceRefs: [ref],
  });

const proposePatchTouching = (path: string) =>
  patchEffect({
    mode: "propose",
    changes: [{ kind: "write", path, content: "x\n" }],
    reason: "test",
    sourceRefs: [ref],
  });

describe("PatchEffect (mode: auto)", () => {
  test("denied when neither patch.auto nor patch.propose granted", () => {
    const r = enforceCapability(patchTouching("wiki/x.md"), [], []);
    expect(r.kind).toBe("deny");
    if (r.kind !== "deny") return;
    expect(r.diagnostic.code).toBe("capability-deny-patch");
  });

  test("downgraded to propose when only patch.propose granted", () => {
    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
    const r = enforceCapability(
      patchTouching("wiki/x.md"),
      [propose],
      [propose],
    );
    expect(r.kind).toBe("downgrade");
    if (r.kind !== "downgrade") return;
    expect(r.diagnostic.code).toBe("capability-downgrade-surprise");
    if (r.rewrittenEffect.kind !== "patch") {
      throw new Error("rewritten effect should be a patch");
    }
    expect(r.rewrittenEffect.mode).toBe("propose");
  });

  test("allowed when patch.auto granted for the touched path", () => {
    const auto: Capability = { kind: "patch.auto", paths: ["wiki/**"] };
    const r = enforceCapability(patchTouching("wiki/x.md"), [auto], [auto]);
    expect(r.kind).toBe("allow");
  });

  test("denied when any changed path lacks an effective patch grant", () => {
    const auto: Capability = { kind: "patch.auto", paths: ["wiki/**"] };
    const r = enforceCapability(
      patchTouchingMany(["wiki/x.md", "private/y.md"]),
      [auto],
      [auto],
    );
    expect(r.kind).toBe("deny");
    if (r.kind !== "deny") return;
    expect(r.diagnostic.message).toContain("private/y.md");
  });

  test("downgraded only when patch.propose covers every changed path", () => {
    const auto: Capability = { kind: "patch.auto", paths: ["wiki/**"] };
    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**", "notes/**"] };
    const r = enforceCapability(
      patchTouchingMany(["wiki/x.md", "notes/y.md"]),
      [auto, propose],
      [auto, propose],
    );
    expect(r.kind).toBe("downgrade");
  });

  test("denied when a later changed path is owned by another processor", () => {
    const auto: Capability = { kind: "patch.auto", paths: ["**"] };
    const owner: Capability = { kind: "owns.path", paths: ["owned/**"] };
    const r = enforceCapability(
      patchTouchingMany(["wiki/x.md", "owned/y.md"]),
      [auto],
      [auto, owner],
    );
    expect(r.kind).toBe("deny");
    if (r.kind !== "deny") return;
    expect(r.diagnostic.message).toContain("owned/y.md");
  });
});

describe("PatchEffect (mode: propose)", () => {
  test("denied when no patch.propose granted", () => {
    const r = enforceCapability(proposePatchTouching("wiki/x.md"), [], []);
    expect(r.kind).toBe("deny");
  });

  test("denied when a later changed path lacks patch.propose", () => {
    const propose: Capability = { kind: "patch.propose", paths: ["wiki/**"] };
    const r = enforceCapability(
      patchEffect({
        mode: "propose",
        changes: [
          { kind: "write", path: "wiki/x.md", content: "x\n" },
          { kind: "write", path: "private/y.md", content: "y\n" },
        ],
        reason: "test",
        sourceRefs: [ref],
      }),
      [propose],
      [propose],
    );
    expect(r.kind).toBe("deny");
    if (r.kind !== "deny") return;
    expect(r.diagnostic.message).toContain("private/y.md");
  });
});

describe("DiagnosticEffect", () => {
  test("always allowed (no capability required)", () => {
    const e = diagnosticEffect({
      severity: "warning",
      code: "x",
      message: "y",
      sourceRefs: [],
    });
    const r = enforceCapability(e, [], []);
    expect(r.kind).toBe("allow");
  });
});

describe("FactEffect", () => {
  const makeFact = (predicate: string) =>
    factEffect({
      subject: { kind: "page", path: "wiki/x.md" },
      predicate,
      object: { kind: "string", value: "v" },
      assertion: "explicit",
      sourceRefs: [ref],
    });

  test("denied when graph.write does not cover the predicate's namespace", () => {
    const cap: Capability = { kind: "graph.write", namespaces: ["other.ns"] };
    const r = enforceCapability(makeFact("dome.tasks.dueDate"), [cap], [cap]);
    expect(r.kind).toBe("deny");
    if (r.kind !== "deny") return;
    expect(r.diagnostic.code).toBe("capability-deny-graph-write");
  });

  test("allowed when graph.write covers the predicate's namespace", () => {
    const cap: Capability = { kind: "graph.write", namespaces: ["dome.tasks"] };
    const r = enforceCapability(makeFact("dome.tasks.dueDate"), [cap], [cap]);
    expect(r.kind).toBe("allow");
  });
});

describe("ExternalActionEffect", () => {
  const e = externalActionEffect({
    capability: "calendar.write",
    idempotencyKey: "e-1",
    payload: {},
    sourceRefs: [ref],
  });

  test("denied when no matching external capability", () => {
    const r = enforceCapability(e, [], []);
    expect(r.kind).toBe("deny");
    if (r.kind !== "deny") return;
    expect(r.diagnostic.code).toBe("capability-deny-external");
  });

  test("allowed when matching external capability granted", () => {
    const cap: Capability = { kind: "external", capability: "calendar.write" };
    const r = enforceCapability(e, [cap], [cap]);
    expect(r.kind).toBe("allow");
  });
});

describe("ViewEffect", () => {
  test("ViewEffect always allowed (phase-mismatch handled elsewhere)", () => {
    const e = viewEffect({
      name: "x",
      content: { kind: "markdown", body: "ok" },
      scope: [ref],
    });
    const r = enforceCapability(e, [], []);
    expect(r.kind).toBe("allow");
  });
});

describe("JobEffect", () => {
  test("denied when no matching job.enqueue grant exists", () => {
    const e = jobEffect({
      processorId: "dome.test",
      input: null,
      idempotencyKey: "j-1",
    });
    const r = enforceCapability(e, [], []);
    expect(r.kind).toBe("deny");
    if (r.kind !== "deny") return;
    expect(r.diagnostic.code).toBe("capability-deny-job-enqueue");
  });

  test("allowed when job.enqueue covers the target processor", () => {
    const e = jobEffect({
      processorId: "dome.test.worker",
      input: null,
      idempotencyKey: "j-1",
    });
    const cap: Capability = { kind: "job.enqueue", processors: ["dome.test.*"] };
    const r = enforceCapability(e, [cap], [cap]);
    expect(r.kind).toBe("allow");
  });
});

describe("QuestionEffect", () => {
  const q = questionEffect({
    question: "ok?",
    sourceRefs: [ref],
    idempotencyKey: "q-1",
  });

  test("allowed when question.ask granted (declared + granted)", () => {
    const cap: Capability = { kind: "question.ask" };
    const r = enforceCapability(q, [cap], [cap]);
    expect(r.kind).toBe("allow");
  });

  test("denied when no question.ask granted", () => {
    const r = enforceCapability(q, [], []);
    expect(r.kind).toBe("deny");
    if (r.kind !== "deny") return;
    expect(r.diagnostic.code).toBe("capability-deny-question-ask");
  });
});
