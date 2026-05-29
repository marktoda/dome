import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.bundle-id-map",
);

scenario(
  {
    name: "garden-cascade: engine trailers use runtime bundle id map",
    tags: [
      { kind: "group", group: "garden-cascade" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
    ],
    harness: {
      bundles: [{ id: "test.bundle-id-map", root: FIXTURE_BUNDLE_ROOT }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.bundle-id-map:
    enabled: true
    grant:
      read: ["wiki/**"]
      patch.auto: ["wiki/**"]
`,
      },
    },
  },
  async (h) => {
    await h.tick();

    await h.userCommit({
      files: { "wiki/adopt.md": "# Adopt\n" },
      message: "trigger adoption patch",
    });
    const adoption = await h.tick();
    expect(adoption.adopted).toBe(true);

    let refs = await h.refs.current();
    if (refs.adopted === null) throw new Error("expected adopted ref");
    await h
      .expectCommit(refs.adopted)
      .toHaveTrailerValues({ "Dome-Extension": "test.bundle-id-map" });

    const diagnosticRows = h.projection.raw
      .query<{ adopted_commit: string }, []>(
        "SELECT adopted_commit FROM diagnostics WHERE code = 'test.bundle-id-map.garden-diagnostic'",
      )
      .all();
    expect(diagnosticRows).toEqual([{ adopted_commit: refs.adopted }]);

    await h.userCommit({
      files: { "wiki/seed.md": "# Seed\n" },
      message: "trigger garden patch",
    });
    const garden = await h.tick();
    expect(garden.adopted).toBe(true);

    refs = await h.refs.current();
    if (refs.adopted === null) throw new Error("expected adopted ref");
    await h
      .expectCommit(refs.adopted)
      .toHaveTrailerValues({ "Dome-Extension": "test.bundle-id-map" });
  },
);
