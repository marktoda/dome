// scenarios/effect-kinds/patch-effect-applies.scenario.test.ts
//
// A PatchEffect from normalize-frontmatter produces an engine commit on
// the source branch with the four Dome-* trailers. The commit's tree reflects
// the normalized content, and the compiler host materializes the changed paths
// into the working tree so the checked-out branch and filesystem stay aligned.

import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: PatchEffect applies as engine commit and materializes working tree",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "patch.auto" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: init adopted ref.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit a file with messy frontmatter and no broken wikilinks.
    const userContent = "---\nid: foo\ntype: page\n---\n# body\n";
    await h.userCommit({
      files: { "wiki/foo.md": userContent },
      message: "messy frontmatter",
    });

    // Step 2: adopt.
    const result = await h.tick();
    expect(result.adopted).toBe(true);
    expect(result.hadDrift).toBe(true);

    // Step 3: a closure commit landed on main with engine(adopt) subject
    // and all four Dome-* trailers.
    const refs = await h.refs.current();
    await h
      .expectCommit(refs.head)
      .toHaveSubjectMatching(/^(engine\(|adopt:)/);
    await h
      .expectCommit(refs.head)
      .toHaveAllTrailers([
        "Dome-Run",
        "Dome-Extension",
        "Dome-Base",
        "Dome-Source-Head",
      ]);

    // Step 4: the file at HEAD is normalized (type first).
    await h
      .expectFile("wiki/foo.md")
      .toMatch(/type:\s*page[\s\S]*id:\s*foo/);

    // Step 5: the working tree file matches the engine-advanced branch.
    const workingTree = await readFile(
      join(h.vaultPath, "wiki/foo.md"),
      "utf8",
    );
    expect(workingTree).toMatch(/type:\s*page[\s\S]*id:\s*foo/);

    // Step 6: exactly one normalize-frontmatter run has a non-null
    // output_commit equal to HEAD (the closure commit). The adoption loop
    // produces two rows for this processor: one for the patch-emitting
    // iteration (its output_commit is back-filled to the closure OID) and
    // one for the convergence iteration that emitted no effects (its
    // output_commit stays NULL). The `withOutputCommit: true` filter
    // narrows to the contributing-run row.
    await h
      .expectLedger({ processorId: "dome.markdown.normalize-frontmatter" })
      .toAllHaveStatus("succeeded");
    const contributingRun = await h
      .expectLedger({
        processorId: "dome.markdown.normalize-frontmatter",
        withOutputCommit: true,
      })
      .toHaveExactlyOne();
    expect(contributingRun.outputCommit).toBe(refs.head);
  },
);

scenario(
  {
    name: "effect-kinds: engine patch does not overwrite uncommitted working tree edits",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "patch.auto" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const userContent = "---\nid: foo\ntype: page\n---\n# body\n";
    const userHead = await h.userCommit({
      files: { "wiki/foo.md": userContent },
      message: "messy frontmatter",
    });
    const localEdit = "---\nid: foo\ntype: page\n---\n# local edit\n";
    await h.userEdit({ files: { "wiki/foo.md": localEdit } });

    const result = await h.tick();
    expect(result.adopted).toBe(false);
    // One blocking materialize conflict plus the missing-description info
    // nudges the new page's lint iterations emit (the page carries no
    // `description:` frontmatter).
    expect(result.diagnosticCount).toBe(3);
    await h
      .expectProjection()
      .diagnostics({
        code: "adoption.working-tree-materialize-conflict",
        severity: "block",
      })
      .toHaveCount(1);
    await h.expectRef("refs/heads/main").toEqual(userHead);

    const workingTree = await readFile(
      join(h.vaultPath, "wiki/foo.md"),
      "utf8",
    );
    expect(workingTree).toBe(localEdit);

    await h.userCommit({
      files: { "wiki/foo.md": localEdit },
      message: "commit local edit",
    });

    const recovered = await h.tick();
    expect(recovered.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({
        code: "adoption.working-tree-materialize-conflict",
        severity: "block",
      })
      .toHaveCount(0);
  },
);
