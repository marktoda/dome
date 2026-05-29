// scenarios/cli-surface/rebuild-projection.scenario.test.ts
//
// `dome rebuild` is the user-facing recovery path for rebuildable
// projection state. It must recreate facts/diagnostics from the adopted
// commit without touching git history, runs.db, or outbox.db.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome rebuild restores projection rows from adopted state",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown", "dome.graph"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/source.md":
          "# Source\n\n" +
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

    const cli = await h.runCli(["rebuild", "--json"]);
    expect(cli.exitCode).toBe(0);
    const payload = JSON.parse(cli.stdout) as {
      readonly status: string;
      readonly adopted: string;
      readonly effects: number;
    };
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

    const meta = h.projection.raw
      .query<{
        adopted_commit: string | null;
        extension_set_hash: string | null;
        processor_versions_hash: string | null;
      }, []>(
        "SELECT adopted_commit, extension_set_hash, processor_versions_hash FROM projection_meta",
      )
      .get();
    expect(meta?.adopted_commit).toBe(adoptedRef);
    expect(typeof meta?.extension_set_hash).toBe("string");
    expect(typeof meta?.processor_versions_hash).toBe("string");
  },
);
