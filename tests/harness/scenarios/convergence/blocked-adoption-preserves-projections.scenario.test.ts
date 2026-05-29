import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const BLOCKER_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.block-adoption",
);

scenario(
  {
    name: "convergence: blocked adoption preserves adopted projection facts",
    tags: [
      { kind: "group", group: "convergence" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.graph"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/source.md": "# source\n\nAdopted content links to [[entity-a]].\n",
      },
      message: "add adopted source link",
    });
    const adopted = await h.tick();
    expect(adopted.adopted).toBe(true);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.graph.links_to",
        subjectId: "wiki/source.md",
        objectString: "entity-a",
      })
      .toHaveCount(1);

    await h.install([{ id: "test.block-adoption", root: BLOCKER_BUNDLE }]);
    await h.userCommit({
      files: {
        "wiki/source.md": "# source\n\nProposed content removes the link.\n",
      },
      message: "remove link but block adoption",
    });

    const blocked = await h.tick();
    expect(blocked.adopted).toBe(false);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.graph.links_to",
        subjectId: "wiki/source.md",
        objectString: "entity-a",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "test.block-adoption.blocked", severity: "block" })
      .toHaveCount(1);
  },
);
