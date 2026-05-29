// scenarios/cli-surface/sync-rebuilds-stale-projections.scenario.test.ts
//
// Projection cache-key drift must not leave stale or missing projection
// rows behind. When the loaded processor-version hash no longer matches
// `projection_meta`, `dome sync` rebuilds projection state from the adopted
// commit even when HEAD is already in sync.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome sync rebuilds projection rows on cache-key drift",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "graph.write" },
    ],
    harness: { bundles: ["dome.markdown", "dome.graph"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/source.md": "# Source\n\nSee [[target]].\n",
        "wiki/target.md": "# Target\n",
      },
      message: "add linked pages",
    });

    const adopted = await h.tick();
    expect(adopted.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({ predicate: "dome.graph.links_to" })
      .toHaveCount(1);

    h.projection.raw.run(
      "UPDATE projection_meta SET processor_versions_hash = 'stale-version-hash'",
    );
    h.projection.raw.run("DELETE FROM facts");
    await h
      .expectProjection()
      .facts({ predicate: "dome.graph.links_to" })
      .toHaveCount(0);

    const cli = await h.runCli(["sync", "--json"]);
    expect(cli.exitCode).toBe(0);
    const payload = JSON.parse(cli.stdout) as { readonly status: string };
    expect(payload.status).toBe("in-sync");

    await h
      .expectProjection()
      .facts({ predicate: "dome.graph.links_to" })
      .toHaveCount(1);

    const meta = h.projection.raw
      .query<{ processor_versions_hash: string | null }, []>(
        "SELECT processor_versions_hash FROM projection_meta",
      )
      .get();
    expect(meta?.processor_versions_hash).not.toBe("stale-version-hash");
    expect(typeof meta?.processor_versions_hash).toBe("string");
  },
);
