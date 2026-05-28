// scenarios/effect-kinds/snapshot-reads-candidate-not-working-tree.scenario.test.ts
//
// The processor's `ctx.snapshot.readFile()` reads from the CANDIDATE tree
// (the latest commit), never from the working tree. A user can have
// uncommitted edits in the working tree; the engine ignores them until
// the user commits — that's part of the source-of-truth contract.
//
// Setup:
//   1. Install dome.markdown.
//   2. Commit a CLEAN markdown file (no broken links).
//   3. userEdit (NOT commit) the file to introduce a broken wikilink.
//   4. Tick.
//
// Post-conditions:
//   - The tick is a no-op (no drift between adopted and HEAD).
//   - No diagnostic for the broken wikilink was emitted: the processor
//     read `ctx.snapshot.readFile()` and saw the clean committed content,
//     not the working-tree-only broken-link version.
//   - The working tree still has the broken-link version (the user's
//     uncommitted edit is preserved).
//
// This catches "processor accidentally reads from disk instead of
// snapshot" — a class of bug that would let working-tree edits leak
// into adoption and break the markdown-is-source-of-truth invariant.

import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: ctx.snapshot reads candidate tree, not working-tree edits",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      // dome.markdown processors declare `read` capability; this scenario
      // exercises the substrate's path filter by reading `wiki/page.md`
      // through ctx.snapshot. Pinning the tag here ensures the H3
      // coverage matrix sees `read` as exercised end-to-end.
      { kind: "capability", capability: "read" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: init the adopted ref.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit a CLEAN file (no broken links).
    const cleanContent = "# page\n\nclean body, no wikilinks\n";
    await h.userCommit({
      files: { "wiki/page.md": cleanContent },
      message: "clean file",
    });

    // Adopt the clean commit. No diagnostics yet.
    {
      const adoptClean = await h.tick();
      expect(adoptClean.adopted).toBe(true);
    }
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);

    // Step 2: working-tree edit (NO commit). This adds a broken wikilink
    // to the file on disk; the latest commit's blob is unchanged.
    const dirtyContent = "# page\n\nnow [[never-committed-target]]\n";
    await h.userEdit({ files: { "wiki/page.md": dirtyContent } });

    // Step 3: tick. The drift detector compares refs/heads/main against
    // refs/dome/adopted/main; both are at the clean commit, so this is
    // an in-sync no-op.
    const tickAfterEdit = await h.tick();
    expect(tickAfterEdit.hadDrift).toBe(false);

    // Step 4: no diagnostic for the working-tree-only broken wikilink.
    // The processor never saw it: ctx.snapshot.readFile reads from the
    // candidate tree, which is still pointing at the clean commit.
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(0);

    // Step 5: the working tree still has the broken-link version. The
    // engine doesn't touch the working tree on no-op ticks; the user's
    // uncommitted edit survives.
    const workingTreeAfter = await readFile(
      join(h.vaultPath, "wiki/page.md"),
      "utf8",
    );
    expect(workingTreeAfter).toBe(dirtyContent);
  },
);
