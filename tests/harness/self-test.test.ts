// tests/harness/self-test.test.ts — framework self-tests.
//
// Tiny scenarios that exercise the harness's own moves + matchers. NOT
// testing Dome behavior; testing that the harness machinery is wired
// correctly. These run on every CI and catch regressions in the
// framework itself.

import { expect } from "bun:test";

import { scenario } from "./index";

scenario(
  {
    name: "self-test: fresh vault has HEAD and no adopted ref",
    tags: [{ kind: "group", group: "regression" }],
  },
  async (h) => {
    await h.expectRef("refs/heads/main").toExist();
    await h.expectRef("refs/dome/adopted/main").toNotExist();
    await h.expectFile(".dome/config.yaml").toBeAbsent();
  },
);

scenario(
  {
    name: "self-test: configured fixtures inherit the harness processor deadline",
    tags: [{ kind: "group", group: "regression" }],
    harness: {
      initialFiles: {
        ".dome/config.yaml": "extensions: {}\n",
      },
    },
  },
  async (h) => {
    await h
      .expectFile(".dome/config.yaml")
      .toContain("processor_timeout_ms: 5000");
  },
);

scenario(
  {
    name: "self-test: configured fixtures preserve an explicit processor deadline",
    tags: [{ kind: "group", group: "regression" }],
    harness: {
      initialFiles: {
        ".dome/config.yaml": [
          "engine:",
          "  processor_timeout_ms: 17",
          "extensions: {}",
          "",
        ].join("\n"),
      },
    },
  },
  async (h) => {
    await h
      .expectFile(".dome/config.yaml")
      .toContain("processor_timeout_ms: 17");
    await h
      .expectFile(".dome/config.yaml")
      .toNotContain("processor_timeout_ms: 5000");
  },
);

scenario(
  {
    name: "self-test: userCommit advances HEAD",
    tags: [{ kind: "group", group: "regression" }],
  },
  async (h) => {
    await h.userCommit({
      files: { "a.md": "hello\n" },
      message: "add a.md",
    });
    await h.expectRef("refs/heads/main").toHaveAdvanced();
    await h.expectFile("a.md").toEqual("hello\n");
  },
);

scenario(
  {
    name: "self-test: empty-diff tick initializes adopted ref",
    tags: [{ kind: "group", group: "regression" }],
  },
  async (h) => {
    // No bundles installed → no processors → empty-diff init advances
    // the adopted ref from null to HEAD without engine writes.
    const result = await h.tick();
    expect(result.adopted).toBe(true);
    await h.expectRef("refs/dome/adopted/main").toEqualHead();

    // Second tick is a no-op (in-sync).
    const second = await h.tick();
    expect(second.hadDrift).toBe(false);
  },
);

scenario(
  {
    name: "self-test: ledger has no orphans on a fresh vault",
    tags: [{ kind: "group", group: "regression" }],
  },
  async (h) => {
    await h.expectLedger().toHaveNoOrphans();
    await h.expectLedger().toHaveCount(0);
  },
);

scenario(
  {
    name: "self-test: file matcher reads from working tree pre-commit",
    tags: [{ kind: "group", group: "regression" }],
  },
  async (h) => {
    await h.userEdit({ files: { "draft.md": "draft body\n" } });
    // Pre-commit: the file is in the working tree, not in any commit.
    // The harness's FileMatcher falls back to the working tree when
    // the path doesn't resolve at HEAD.
    await h.expectFile("draft.md").toContain("draft body");
  },
);

scenario(
  {
    name: "self-test: advance(ms) moves the clock without touching state",
    tags: [{ kind: "group", group: "regression" }],
  },
  async (h) => {
    const before = h.clock.nowMs();
    await h.advance(60_000);
    const after = h.clock.nowMs();
    expect(after - before).toBe(60_000);
    // Refs are unchanged across a pure-time advance.
    await h.expectRef("refs/heads/main").toBeUnchanged();
  },
);

scenario(
  {
    name: "self-test: fresh vault has empty projection + outbox + commit-zero",
    tags: [{ kind: "group", group: "regression" }],
  },
  async (h) => {
    // Sanity check on the diagnostics/facts/questions/outbox matchers
    // against a fresh vault — all should report zero rows.
    await h.expectProjection().diagnostics().toHaveCount(0);
    await h.expectProjection().facts().toHaveCount(0);
    await h.expectProjection().questions().toHaveCount(0);
    await h.expectOutbox().toHaveCount().matching(0);
    await h.expectOutbox().toHaveNoStaleRows(60_000);
  },
);

scenario(
  {
    name: "self-test: harness initial commit has no Dome trailers (not an engine commit)",
    tags: [{ kind: "group", group: "regression" }],
    timeoutMs: 30_000,
  },
  async (h) => {
    const head = await h.refs.head();
    // The seed commit's subject is `harness: initial commit` — NOT
    // `engine(...)` or `adopt:`, so it doesn't match the engine-commit
    // pattern. The always-true invariant only checks engine commits.
    await h
      .expectCommit(head)
      .toHaveSubjectMatching(/^harness: initial commit/);
  },
);
