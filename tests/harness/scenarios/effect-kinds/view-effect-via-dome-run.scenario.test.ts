// scenarios/effect-kinds/view-effect-via-dome-run.scenario.test.ts
//
// dome.markdown.orphan-pages (Phase 13a) is the first view-phase
// processor with real behavior. Invoked via `dome run orphan-pages`,
// it reads `dome.graph.links_to` facts from the projection, computes
// incoming-link counts per markdown page, and emits a ViewEffect
// listing every page with zero incoming links. This scenario covers:
//
//   - the first ViewEffect-emitting processor with end-to-end coverage,
//   - the first view-phase processor with end-to-end coverage,
//   - the first command-triggered processor invocation,
//   - the `dome run <name>` CLI surface (the first `dome run` test),
//   - the `runCli` harness helper.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: dome run orphan-pages surfaces orphans via ViewEffect",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: { bundles: ["dome.markdown", "dome.graph"] },
  },
  async (h) => {
    // Step 0: init adopted ref.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit a small vault.
    //   - wiki/foo.md     — no incoming explicit wikilinks; would be
    //                       orphan, but `wiki/bar.md` wikilinks to it.
    //   - wiki/bar.md     — contains `[[foo]]`; not orphan because it
    //                       has its own incoming via wiki/index.md
    //                       implicit edge... wait — bar has no
    //                       explicit links. But wiki/index.md exists
    //                       (see below), so bar gets the implicit
    //                       link from index.
    //   - wiki/lonely.md  — no incoming explicit wikilinks AND no
    //                       implicit link from the root index (because
    //                       we omit `wiki/index.md` to keep the test
    //                       focused on the explicit-link path).
    //
    // To exercise the explicit-link orphan-detection cleanly we omit
    // `wiki/index.md` from this scenario; `lonely.md` becomes orphan
    // exactly because nothing wikilinks to it.
    await h.userCommit({
      files: {
        "wiki/foo.md": "# foo\n\nthis is foo\n",
        "wiki/bar.md": "# bar\n\nrefers to [[foo]]\n",
        "wiki/lonely.md": "# lonely\n\nno one links here\n",
      },
      message: "vault with linked + orphan pages",
    });

    // Step 2: adopt — dome.graph.links emits `links_to` facts (one
    // for bar → foo).
    const result = await h.tick();
    expect(result.adopted).toBe(true);
    await h
      .expectProjection()
      .facts({ predicate: "dome.graph.links_to" })
      .toHaveCount(1);

    // Step 3: invoke `dome run orphan-pages --json` via the harness's
    // runCli helper. The command exits 0 on success and prints the
    // ViewEffect's payload to stdout.
    const cli = await h.runCli(["run", "orphan-pages", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");

    // Step 4: parse the JSON output. The command emits a single
    // ViewEffect, so the top-level value is a single render object
    // (the unwrapping happens in renderView).
    const payload = JSON.parse(cli.stdout) as {
      readonly name: string;
      readonly kind: "structured";
      readonly schema: string;
      readonly data: {
        readonly schema: string;
        readonly asOfCommit: string;
        readonly orphans: ReadonlyArray<{
          readonly path: string;
          readonly incomingLinkCount: 0;
          readonly reason: string;
        }>;
        readonly totalScanned: number;
        readonly totalOrphans: number;
      };
    };
    expect(payload.name).toBe("dome.markdown.orphan-pages");
    expect(payload.kind).toBe("structured");
    expect(payload.schema).toBe("dome.markdown.orphan-pages/v1");

    // Step 5: lonely.md is reported as orphan; foo.md is not (bar
    // wikilinks to it).
    const orphanPaths = payload.data.orphans.map((o) => o.path);
    expect(orphanPaths).toContain("wiki/lonely.md");
    expect(orphanPaths).not.toContain("wiki/foo.md");

    // bar.md has no incoming wikilinks of its own and no root-index
    // implicit link (we didn't commit wiki/index.md), so it's also
    // orphan. Verify it lands in the orphan list — this guards the
    // "incoming-link-count = 0" semantics.
    expect(orphanPaths).toContain("wiki/bar.md");

    // Step 6: total counts add up.
    expect(payload.data.totalScanned).toBe(3);
    expect(payload.data.totalOrphans).toBeGreaterThanOrEqual(2);
    expect(payload.data.totalOrphans).toBe(orphanPaths.length);
  },
);
