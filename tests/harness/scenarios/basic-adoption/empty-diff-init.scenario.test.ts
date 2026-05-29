// scenarios/basic-adoption/empty-diff-init.scenario.test.ts
//
// First tick against an empty vault (no bundles, no user changes since the
// seed commit) is an empty-diff init: the adopted ref is fast-forwarded
// to HEAD with no processor runs, no closure commit, no diagnostics.
//
// This pins the "init from null" path that every later scenario relies on.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "basic-adoption: empty-diff init advances adopted ref to HEAD without engine work",
    tags: [
      { kind: "group", group: "basic-adoption" },
      { kind: "phase", phase: "adoption" },
      { kind: "route", route: "adoption" },
    ],
  },
  async (h) => {
    // Pre-state: HEAD exists (seed commit), adopted ref is unset.
    await h.expectRef("refs/heads/main").toExist();
    await h.expectRef("refs/dome/adopted/main").toNotExist();

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    // Adopted ref now equals HEAD.
    await h.expectRef("refs/dome/adopted/main").toEqualHead();
    // refs/heads/main did NOT move (no closure commit on init).
    await h.expectRef("refs/heads/main").toBeUnchanged();

    // Zero processor runs landed in the ledger: no bundles installed, no
    // processors to fire.
    await h.expectLedger().toHaveCount(0);

    // No closure commit on the source branch — every commit in the history
    // is the harness seed, not an engine commit.
    const closureCommits = await h.git.commitsMatching(/^(engine\(|adopt:)/);
    expect(closureCommits.length).toBe(0);

    // No projection rows.
    await h.expectProjection().diagnostics().toHaveCount(0);
    await h.expectProjection().facts().toHaveCount(0);
  },
);
