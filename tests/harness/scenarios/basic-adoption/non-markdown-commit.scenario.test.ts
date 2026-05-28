// scenarios/basic-adoption/non-markdown-commit.scenario.test.ts
//
// A commit that contains only non-markdown files. dome.markdown is installed.
// Both shipped processors subscribe to `file.created` which fires for any
// file path — but each processor filters to .md inside its body and emits
// zero effects.
//
// Post-conditions:
//   - tick adopts successfully
//   - refs/heads/main and refs/dome/adopted/main both at the user's commit
//     (no closure commit, no patch effects)
//   - any ledger row for a shipped markdown processor has status='succeeded'
//     with zero output (the run was bounded; the processor was invoked and
//     emitted nothing)

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "basic-adoption: non-markdown commit produces no closure commit and no patch",
    tags: [
      { kind: "group", group: "basic-adoption" },
      { kind: "phase", phase: "adoption" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: init the adopted ref so the next tick has a base to diff from.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit non-markdown files only. The `file.created` signal
    // will fire for both — but neither markdown processor will produce an
    // effect because both filter to `.md` inside `run`.
    const userHead = await h.userCommit({
      files: {
        "README.txt": "plain text\n",
        "config.json": '{"k": "v"}\n',
      },
      message: "add non-markdown",
    });

    // Step 2: adopt.
    const result = await h.tick();
    expect(result.adopted).toBe(true);
    expect(result.hadDrift).toBe(true);
    expect(result.diagnosticCount).toBe(0);

    // Step 3: both refs land at the user's commit; NO closure commit was
    // created.
    await h.expectRef("refs/heads/main").toEqual(userHead);
    await h.expectRef("refs/dome/adopted/main").toEqual(userHead);

    // Step 4: no closure commit on the source branch.
    const closureCommits = await h.git.commitsMatching(/^(engine\(|adopt:)/);
    expect(closureCommits.length).toBe(0);

    // Step 5: no diagnostics or facts written.
    await h.expectProjection().diagnostics().toHaveCount(0);
    await h.expectProjection().facts().toHaveCount(0);
  },
);
