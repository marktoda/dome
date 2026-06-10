// scenarios/cli-surface/reanchor-divergence.scenario.test.ts
//
// The history-rewrite guardrail end to end (docs/wiki/gotchas/
// adopted-ref-divergence.md + docs/wiki/specs/cli.md §"dome reanchor").
// A foreground agent running `git reset --hard` orphans previously-adopted
// commits; Dome must NOT silently follow the rewrite and must NOT
// hard-error-loop. Instead:
//
//   - doctor/check/status surface ONE idempotent `adopted-ref.diverged`
//     finding carrying both SHAs and the orphaned-commit count, with
//     recovery text naming `dome reanchor`;
//   - `dome reanchor` refuses when the vault is NOT diverged (exit 64);
//   - the happy path backs the old adopted SHA up under
//     `refs/dome/backup/adopted-<timestamp>` before moving, then runs a
//     normal sync tick;
//   - post-reanchor adoption proceeds normally.

import { expect } from "bun:test";

import { adoptedRefName } from "../../../../src/adopted-ref";
import { readRef } from "../../../../src/git";
import { scenario } from "../../index";

const VAULT_SHIM_FILES = Object.freeze({
  ".dome/config.yaml": "extensions: {}\n",
  "AGENTS.md":
    "# This is a Dome vault.\n\n" +
    "<!-- BEGIN user-prose -->\n" +
    "<!-- END user-prose -->\n",
  "CLAUDE.md": "@AGENTS.md\n",
});

scenario(
  {
    name:
      "cli-surface: history rewrite raises one diverged finding and dome reanchor recovers",
    tags: [{ kind: "group", group: "cli-surface" }],
    harness: { initialFiles: { ...VAULT_SHIM_FILES } },
  },
  async (h) => {
    // Seed: initialize the adopted ref, then adopt one more commit so a
    // rewind has something to orphan.
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);
    const c1 = await h.refs.head();

    await h.userCommit({
      files: { "wiki/work.md": "# Work\n\nadopted work\n" },
      message: "add wiki/work.md",
    });
    const adoptTick = await h.tick();
    expect(adoptTick.adopted).toBe(true);
    const c2 = await h.refs.adopted();
    expect(c2).not.toBeNull();
    if (c2 === null) throw new Error("expected adopted ref");

    // Refusal when clean: the vault is in sync — reanchor must refuse so a
    // non-diverged vault can never force-move its cursor.
    const clean = await h.runCli(["reanchor", "--json"]);
    expect(clean.exitCode).toBe(64);
    const cleanPayload = JSON.parse(clean.stdout) as Record<string, unknown>;
    expect(cleanPayload["schema"]).toBe("dome.reanchor/v1");
    expect(cleanPayload["status"]).toBe("error");
    expect(cleanPayload["error"]).toBe("not-diverged");
    expect(String(cleanPayload["message"])).toContain("dome sync");

    // Simulate the live incident: a foreground agent runs
    // `git reset --hard <c1>`, rewriting the branch ref under the adopted
    // cursor. The adopted ref (c2) is no longer an ancestor of HEAD (c1).
    await h.userRewriteBranch(c1);

    // The daemon-shaped finding: ONE `adopted-ref.diverged` error with both
    // SHAs, the orphaned-commit count, and recovery naming `dome reanchor`.
    const doctor = await h.runCli(["doctor", "--json"]);
    expect(doctor.exitCode).toBe(0);
    const report = JSON.parse(doctor.stdout) as {
      readonly status: string;
      readonly summary: { readonly adoptedRefDivergence: number };
      readonly findings: ReadonlyArray<{
        readonly code: string;
        readonly severity: string;
        readonly message: string;
        readonly recovery: string;
        readonly git?: {
          readonly branch: string;
          readonly head: string;
          readonly adopted: string;
          readonly orphanedCommits: number | null;
        };
      }>;
    };
    expect(report.status).toBe("unhealthy");
    expect(report.summary.adoptedRefDivergence).toBe(1);
    const diverged = report.findings.filter(
      (finding) => finding.code === "adopted-ref.diverged",
    );
    expect(diverged).toHaveLength(1);
    const finding = diverged[0];
    if (finding === undefined) throw new Error("expected diverged finding");
    expect(finding.severity).toBe("error");
    expect(finding.git).toEqual({
      branch: h.branch,
      head: c1,
      adopted: c2,
      orphanedCommits: 1,
    });
    expect(finding.message).toContain("1 previously-adopted commit is");
    expect(finding.recovery).toContain("dome reanchor");
    expect(finding.recovery).toContain("refs/dome/backup/");

    // Idempotent, not accumulating: a second probe (the next "poll") still
    // reports exactly one finding.
    const doctorAgain = await h.runCli(["doctor", "--json"]);
    const reportAgain = JSON.parse(doctorAgain.stdout) as {
      readonly findings: ReadonlyArray<{ readonly code: string }>;
    };
    expect(
      reportAgain.findings.filter(
        (row) => row.code === "adopted-ref.diverged",
      ),
    ).toHaveLength(1);

    // Status routes attention at the diverged state and names the recovery
    // command.
    const status = await h.runCli(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    const statusPayload = JSON.parse(status.stdout) as {
      readonly adopted_diverged: boolean;
      readonly attention: ReadonlyArray<string>;
      readonly next_actions: ReadonlyArray<{
        readonly reasons: ReadonlyArray<string>;
        readonly command: string | null;
        readonly description: string;
      }>;
    };
    expect(statusPayload.adopted_diverged).toBe(true);
    expect(
      statusPayload.attention.filter((r) => r === "adopted_ref_diverged"),
    ).toHaveLength(1);
    const reanchorAction = statusPayload.next_actions.find(
      (action) => action.command === "dome reanchor",
    );
    expect(reanchorAction).toBeDefined();
    expect(reanchorAction?.reasons).toEqual(["adopted_ref_diverged"]);

    // Sync still refuses (exit 1) — divergence is never silently followed.
    const sync = await h.runCli(["sync", "--json"]);
    expect(sync.exitCode).toBe(1);
    const syncPayload = JSON.parse(sync.stdout) as {
      readonly error: string;
      readonly attention: ReadonlyArray<string>;
    };
    expect(syncPayload.error).toBe("adopted-ref-diverged");
    expect(syncPayload.attention).toEqual(["adopted_ref_diverged"]);

    // A `--to` target that is not on the rewritten branch is refused before
    // any ref moves.
    const badTo = await h.runCli([
      "reanchor",
      "--to",
      "0123456789012345678901234567890123456789",
      "--json",
    ]);
    expect(badTo.exitCode).toBe(64);
    expect(
      (JSON.parse(badTo.stdout) as Record<string, unknown>)["error"],
    ).toBe("target-not-on-branch");
    expect(await h.refs.adopted()).toBe(c2);

    // Happy path: reanchor to the rewritten HEAD. The old adopted SHA is
    // recorded in the output AND in a refs/dome/backup/ ref before the move.
    const reanchor = await h.runCli(["reanchor", "--json"]);
    expect(reanchor.exitCode).toBe(0);
    const payload = JSON.parse(reanchor.stdout) as {
      readonly schema: string;
      readonly status: string;
      readonly branch: string;
      readonly previous_adopted: string;
      readonly new_adopted: string;
      readonly backup_ref: string;
      readonly sync: { readonly kind: string };
    };
    expect(payload.schema).toBe("dome.reanchor/v1");
    expect(payload.status).toBe("reanchored");
    expect(payload.previous_adopted).toBe(c2);
    expect(payload.new_adopted).toBe(c1);
    expect(payload.backup_ref).toMatch(
      /^refs\/dome\/backup\/adopted-\d{8}T\d{6}Z(-\d+)?$/,
    );
    expect(payload.sync.kind).toBe("in-sync");

    // The backup ref preserves the orphaned adopted SHA; the cursor is at
    // the rewritten HEAD.
    expect(
      await readRef({ path: h.vaultPath, ref: payload.backup_ref }),
    ).toBe(c2);
    expect(
      await readRef({ path: h.vaultPath, ref: adoptedRefName(h.branch) }),
    ).toBe(c1);

    // Reanchor is one-shot: a second invocation refuses (no longer diverged).
    const again = await h.runCli(["reanchor", "--json"]);
    expect(again.exitCode).toBe(64);
    expect(
      (JSON.parse(again.stdout) as Record<string, unknown>)["error"],
    ).toBe("not-diverged");

    // Post-reanchor adoption proceeds normally on the rewritten history.
    await h.userCommit({
      files: { "wiki/after.md": "# After\n\npost-reanchor work\n" },
      message: "add wiki/after.md",
    });
    const postTick = await h.tick();
    expect(postTick.adopted).toBe(true);
    const head = await h.refs.head();
    expect(await h.refs.adopted()).toBe(head);

    // And the divergence finding clears.
    const doctorClear = await h.runCli(["doctor", "--json"]);
    const clearReport = JSON.parse(doctorClear.stdout) as {
      readonly summary: { readonly adoptedRefDivergence: number };
    };
    expect(clearReport.summary.adoptedRefDivergence).toBe(0);
  },
);
