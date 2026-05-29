// scenarios/lifecycle/bundle-uninstall-reinstall.scenario.test.ts
//
// Bundle install / uninstall mechanics: when a bundle is uninstalled, its
// processors stop firing and projection cache-key drift invalidates rows
// owned by the old processor set. Reinstalling the bundle rebuilds
// projections against the current adopted commit.
//
// The point of this scenario is the install/uninstall plumbing (runtime
// reopen, processor-registry refresh) round-trips without crashing or
// corrupting state.

import { expect } from "bun:test";

import { scenario } from "../../index";
import type { Harness } from "../../types";

scenario(
  {
    name: "lifecycle: bundle uninstall stops processing; reinstall resumes without corruption",
    tags: [
      { kind: "group", group: "lifecycle" },
      { kind: "lifecycle", event: "bundle-install" },
      { kind: "lifecycle", event: "bundle-remove" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: init.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit a broken-link file with the bundle installed. One
    // diagnostic lands.
    await h.userCommit({
      files: { "wiki/first.md": "[[missing-one]]\n" },
      message: "first broken",
    });
    await h.tick();
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);

    const ledgerCountAfterStep1 = countLedger(h);

    // Step 2: uninstall the bundle. The runtime reopens with no
    // processors registered.
    await h.uninstall("dome.markdown");

    // Step 3: commit ANOTHER broken-link file. With no processor loaded,
    // adoption advances the refs but emits no effects.
    await h.userCommit({
      files: { "wiki/second.md": "[[missing-two]]\n" },
      message: "second broken",
    });
    await h.tick();

    // No new validate-wikilinks runs.
    const ledgerCountAfterStep3 = countLedger(h);
    expect(ledgerCountAfterStep3).toBe(ledgerCountAfterStep1);

    // Extension-set cache-key drift invalidates the old projection rows.
    // With no markdown processor loaded, the rebuild emits no replacement
    // diagnostics.
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);

    // Step 4: reinstall the bundle. The runtime reopens with the
    // processors loaded again.
    await h.install(["dome.markdown"]);

    // Step 5: a tick at this point sees in-sync (the refs already
    // advanced through the uninstall window), but extension-set cache-key
    // drift rebuilds projections from the adopted commit. Both existing
    // broken-link files are visible again.
    const postReinstall = await h.tick();
    expect(postReinstall.hadDrift).toBe(false);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(2);

    // Step 6: commit a third broken-link file. With the bundle back, it
    // gets diagnosed incrementally on top of the rebuilt rows.
    await h.userCommit({
      files: { "wiki/third.md": "[[missing-three]]\n" },
      message: "third broken",
    });
    await h.tick();
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(3);
  },
);

function countLedger(h: Harness): number {
  return (
    h.ledger.raw
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs")
      .all()[0]?.n ?? 0
  );
}
