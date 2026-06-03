// scenarios/cli-surface/rebuild-projection.scenario.test.ts
//
// `dome rebuild` is the user-facing recovery path for rebuildable
// projection state. It must recreate facts/diagnostics from the adopted
// commit without touching git history, runs.db, or outbox.db.

import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const GARDEN_REBUILD_FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.garden-rebuild-facts",
);

scenario(
  {
    name: "cli-surface: dome rebuild restores projection rows from adopted state",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        "dome.graph",
        {
          id: "test.garden-rebuild-facts",
          root: GARDEN_REBUILD_FIXTURE,
        },
      ],
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/source.md":
          "# Source\n\n" +
          "garden-rebuild\n\n" +
          "See [[missing-target]].\n",
      },
      message: "add source page",
    });

    const adopted = await h.tick();
    expect(adopted.adopted).toBe(true);
    const adoptedRef = await h.refs.adopted();
    expect(adoptedRef).not.toBeNull();
    if (adoptedRef === null) throw new Error("expected initialized adopted ref");

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({ predicate: "dome.graph.links_to" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({ predicate: "test.garden_rebuild.seen" })
      .toHaveCount(1);

    h.projection.raw.run("DELETE FROM diagnostics");
    h.projection.raw.run("DELETE FROM facts");
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);
    await h
      .expectProjection()
      .facts({ predicate: "dome.graph.links_to" })
      .toHaveCount(0);
    await h
      .expectProjection()
      .facts({ predicate: "test.garden_rebuild.seen" })
      .toHaveCount(0);

    const cli = await h.runCli(["rebuild", "--json"]);
    expect(cli.exitCode).toBe(0);
    const payload = JSON.parse(cli.stdout) as {
      readonly schema: string;
      readonly status: string;
      readonly adopted: string;
      readonly effects: number;
    };
    expect(payload.schema).toBe("dome.rebuild/v1");
    expect(payload.status).toBe("rebuilt");
    expect(payload.adopted).toBe(adoptedRef);
    expect(payload.effects).toBeGreaterThanOrEqual(2);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({ predicate: "dome.graph.links_to" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({ predicate: "test.garden_rebuild.seen" })
      .toHaveCount(1);

    const meta = h.projection.raw
      .query<{
        adopted_commit: string | null;
        extension_set_hash: string | null;
        processor_versions_hash: string | null;
        capability_policy_hash: string | null;
      }, []>(
        "SELECT adopted_commit, extension_set_hash, processor_versions_hash, "
          + "capability_policy_hash FROM projection_meta",
      )
      .get();
    expect(meta?.adopted_commit).toBe(adoptedRef);
    expect(typeof meta?.extension_set_hash).toBe("string");
    expect(typeof meta?.processor_versions_hash).toBe("string");
    expect(typeof meta?.capability_policy_hash).toBe("string");
  },
);
