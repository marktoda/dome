// scenarios/effect-kinds/patch-effect-applies.scenario.test.ts
//
// A PatchEffect from normalize-frontmatter produces a closure commit on
// the source branch with the four Dome-* trailers. The closure commit's
// tree reflects the normalized content, but the working tree is left
// untouched — the engine writes the commit, it does not check the
// closure tree out into the user's workspace.

import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: PatchEffect applies as closure commit; working tree is untouched",
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

    // Step 5: the working tree file is UNCHANGED from what the user wrote.
    // The engine writes a commit; it does not re-check-out the closure
    // tree over the user's workspace.
    const workingTree = await readFile(
      join(h.vaultPath, "wiki/foo.md"),
      "utf8",
    );
    expect(workingTree).toBe(userContent);

    // Step 6: at least one normalize-frontmatter run is succeeded with
    // output_commit equal to HEAD (the closure commit). The adoption loop
    // produces two rows for this processor: one for the patch-emitting
    // iteration (its output_commit is back-filled to the closure OID) and
    // one for the convergence iteration that emitted no effects (its
    // output_commit stays NULL). We only need the contributing-run row.
    await h
      .expectLedger({ processorId: "dome.markdown.normalize-frontmatter" })
      .toAllHaveStatus("succeeded");
    const rows = h.ledger.raw
      .query<
        { output_commit: string | null },
        [string]
      >(
        "SELECT output_commit FROM runs WHERE processor_id = ? AND output_commit IS NOT NULL",
      )
      .all("dome.markdown.normalize-frontmatter");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.output_commit).toBe(refs.head);
  },
);
