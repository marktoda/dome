// scenarios/basic-adoption/multi-file-commit.scenario.test.ts
//
// Three markdown files committed in one user commit: two with messy
// frontmatter (key-order non-canonical), one already canonical. The
// normalize-frontmatter processor must:
//   - emit one PatchEffect carrying TWO FileChanges (one per messy file)
//   - leave the canonical file untouched
//   - converge in a single closure commit
//
// Asserts the multi-change PatchEffect path that single-file scenarios
// don't exercise.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "basic-adoption: multi-file commit yields one closure commit with two FileChanges",
    tags: [
      { kind: "group", group: "basic-adoption" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "adoption" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: init adopted ref.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit three .md files together. `a.md` and `b.md` have
    // non-canonical key order (id before type); `c.md` is already
    // canonical (type before id, alphabetical trailing keys).
    await h.userCommit({
      files: {
        "wiki/a.md": "---\nid: a\ntype: page\n---\nA\n",
        "wiki/b.md": "---\naliases: []\nid: b\ntype: page\n---\nB\n",
        "wiki/c.md": "---\ntype: page\nid: c\n---\nC\n",
      },
      message: "add three markdown files",
    });

    // Step 2: adopt.
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    // Step 3: exactly one closure commit landed on main.
    const closureCommits = await h.git.commitsMatching(/^(engine\(|adopt:)/);
    expect(closureCommits.length).toBe(1);

    // Both refs advanced to the closure commit.
    await h.expectRef("refs/heads/main").toHaveAdvanced();
    await h.expectRef("refs/dome/adopted/main").toEqualHead();

    // Step 4: normalize-frontmatter has at least one succeeded run.
    await h
      .expectLedger({ processorId: "dome.markdown.normalize-frontmatter" })
      .toAllHaveStatus("succeeded");

    // Step 5: the two messy files are now in canonical order (type before id).
    await h.expectFile("wiki/a.md").toMatch(/type:\s*page[\s\S]*id:\s*a/);
    await h.expectFile("wiki/b.md").toMatch(/type:\s*page[\s\S]*id:\s*b/);

    // Step 6: the already-canonical file is unchanged at HEAD — the
    // processor elides no-op changes, so c.md keeps its original bytes.
    await h.expectFile("wiki/c.md").toEqual("---\ntype: page\nid: c\n---\nC\n");
  },
);
