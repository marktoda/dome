// tests/harness/assertions/always-true.ts — the always-true invariant
// registry + runner.
//
// Every move method on the Harness calls `runAllAlwaysTrue(this, moveDesc)`
// before returning. A violation surfaces as a thrown Error whose message
// names the invariant, the triggering move, and actionable context (the
// substrate doc that pins the rule, where applicable).
//
// Each invariant is a NAMED predicate. The name matches a
// `docs/wiki/invariants/<slug>.md` doc when one exists; runtime-only
// invariants (the orphan check, the sqlite integrity check) name the
// behavior loudly.

import { expect } from "bun:test";

import { orphanRuns, queryRuns } from "../../../src/ledger/runs";
import type { AlwaysTrueInvariant, Harness } from "../types";

const ORPHAN_THRESHOLD_MS = 60_000;

export const ALWAYS_TRUE_INVARIANTS: ReadonlyArray<AlwaysTrueInvariant> =
  Object.freeze([
    {
      name: "ADOPTED_REF_IS_ANCESTOR_OF_HEAD",
      description:
        "refs/dome/adopted/<branch> must be an ancestor-or-equal of refs/heads/<branch>",
      check: async (h: Harness): Promise<void> => {
        const { head, adopted } = await h.refs.current();
        if (adopted === null) return; // uninitialized is valid
        if (head === adopted) return;
        const isAnc = await h.git.isAncestor(adopted, head);
        expect(
          isAnc,
          `ADOPTED_REF_IS_ANCESTOR_OF_HEAD violated:\n` +
            `  refs/heads/${h.branch} = ${head}\n` +
            `  refs/dome/adopted/${h.branch} = ${adopted}\n` +
            `  isAncestor(adopted -> head) = false (likely siblings)\n` +
            `  => A closure commit landed on the adopted ref but not on the source branch.\n` +
            `    See src/engine/adopt.ts "Phase 12c -- advance main alongside adopted ref".`,
        ).toBe(true);
      },
    },

    {
      name: "EVERY_ENGINE_COMMIT_HAS_DOME_TRAILERS",
      description:
        "Every commit whose subject matches /^(engine\\(|adopt:)/ carries the four Dome-* trailers",
      check: async (h: Harness): Promise<void> => {
        const engineCommits = await h.git.commitsMatching(
          /^(engine\(|adopt:)/,
        );
        const required = [
          "Dome-Run",
          "Dome-Extension",
          "Dome-Base",
          "Dome-Source-Head",
        ] as const;
        for (const c of engineCommits) {
          for (const trailer of required) {
            expect(
              c.trailers[trailer],
              `EVERY_ENGINE_COMMIT_HAS_DOME_TRAILERS violated:\n` +
                `  commit ${c.oid.slice(0, 7)} "${c.subject}" is missing ${trailer}\n` +
                `  present trailers: ${Object.keys(c.trailers).join(", ") || "(none)"}\n` +
                `  => The engine made a commit without the canonical provenance trailers.\n` +
                `    See docs/wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS.md.`,
            ).toBeDefined();
          }
        }
      },
    },

    {
      name: "NO_ORPHAN_RUNNING_LEDGER_ROWS",
      description:
        "No ledger row in status='running' older than 60 seconds in the test clock",
      check: async (h: Harness): Promise<void> => {
        const orphans = orphanRuns(
          h.ledger,
          ORPHAN_THRESHOLD_MS,
          h.clock.now(),
        );
        expect(
          orphans.length,
          `NO_ORPHAN_RUNNING_LEDGER_ROWS violated:\n` +
            `  ${orphans.length} row(s) stuck in status='running' for >60s\n` +
            `  IDs: ${orphans
              .slice(0, 5)
              .map((r) => r.id)
              .join(", ")}\n` +
            `  => A processor run was marked running but never reached a terminal state.\n` +
            `    See docs/wiki/specs/run-ledger.md "Orphan runs".`,
        ).toBe(0);
      },
    },

    {
      name: "PROJECTION_ROW_ADOPTED_COMMITS_ARE_REACHABLE",
      description:
        "Every adopted_commit referenced by any projection row exists in git",
      check: async (h: Harness): Promise<void> => {
        const distinctCommits = new Set<string>();
        const factRows = h.projection.raw
          .query<{ adopted_commit: string }, []>(
            "SELECT DISTINCT adopted_commit FROM facts",
          )
          .all();
        const diagRows = h.projection.raw
          .query<{ adopted_commit: string }, []>(
            "SELECT DISTINCT adopted_commit FROM diagnostics",
          )
          .all();
        const quesRows = h.projection.raw
          .query<{ adopted_commit: string }, []>(
            "SELECT DISTINCT adopted_commit FROM questions",
          )
          .all();
        for (const r of factRows) distinctCommits.add(r.adopted_commit);
        for (const r of diagRows) distinctCommits.add(r.adopted_commit);
        for (const r of quesRows) distinctCommits.add(r.adopted_commit);

        for (const c of distinctCommits) {
          const exists = await h.git.commitExists(c);
          expect(
            exists,
            `PROJECTION_ROW_ADOPTED_COMMITS_ARE_REACHABLE violated:\n` +
              `  projection row references adopted_commit ${c.slice(0, 7)} but git doesn't have it\n` +
              `  => A row was written referencing a commit that doesn't exist (or got GC'd).\n` +
              `    See docs/wiki/invariants/PROJECTIONS_ARE_REBUILDABLE.md.`,
          ).toBe(true);
        }
      },
    },

    {
      name: "LEDGER_ROW_INPUT_COMMITS_ARE_REACHABLE",
      description: "Every input_commit on a ledger row exists in git",
      check: async (h: Harness): Promise<void> => {
        const rows = queryRuns(h.ledger);
        for (const r of rows) {
          const exists = await h.git.commitExists(r.inputCommit);
          expect(
            exists,
            `LEDGER_ROW_INPUT_COMMITS_ARE_REACHABLE violated:\n` +
              `  ledger row ${r.id} references input_commit ${r.inputCommit.slice(0, 7)} but git doesn't have it.\n` +
              `  => Ledger orphan -- the run was recorded against a commit that no longer exists.`,
          ).toBe(true);
        }
      },
    },

    {
      name: "LEDGER_ROW_OUTPUT_COMMITS_ARE_REACHABLE",
      description:
        "Every non-null output_commit on a ledger row exists in git",
      check: async (h: Harness): Promise<void> => {
        const rows = queryRuns(h.ledger);
        for (const r of rows) {
          if (r.outputCommit === null) continue;
          const exists = await h.git.commitExists(r.outputCommit);
          expect(
            exists,
            `LEDGER_ROW_OUTPUT_COMMITS_ARE_REACHABLE violated:\n` +
              `  ledger row ${r.id} references output_commit ${r.outputCommit.slice(0, 7)} but git doesn't have it.\n` +
              `  => The engine wrote an output_commit OID that doesn't resolve to a real object.\n` +
              `    See src/engine/closure-commit.ts and docs/wiki/gotchas/run-succeeded-before-closure.md.`,
          ).toBe(true);
        }
      },
    },

    {
      name: "CAPABILITY_USE_ROWS_REFERENCE_VALID_RUNS",
      description: "Every capability_uses.run_id matches a runs.id",
      check: async (h: Harness): Promise<void> => {
        const orphans = h.ledger.raw
          .query<{ id: number; run_id: string }, []>(
            `SELECT cu.id, cu.run_id FROM capability_uses cu ` +
              `LEFT JOIN runs r ON r.id = cu.run_id ` +
              `WHERE r.id IS NULL`,
          )
          .all();
        expect(
          orphans.length,
          `CAPABILITY_USE_ROWS_REFERENCE_VALID_RUNS violated:\n` +
            `  ${orphans.length} capability_uses row(s) reference non-existent runs\n` +
            (orphans.length > 0 && orphans[0] !== undefined
              ? `  first: row ${orphans[0].id} -> run_id ${orphans[0].run_id}\n`
              : "") +
            `  => The capability_uses -> runs foreign key is broken.`,
        ).toBe(0);
      },
    },

    {
      name: "NO_STALE_PENDING_OUTBOX",
      description:
        "No outbox row in status='pending' with attempts >= max_attempts",
      check: async (h: Harness): Promise<void> => {
        const stale = h.outbox.raw
          .query<
            {
              id: number;
              idempotency_key: string;
              attempts: number;
              max_attempts: number;
            },
            []
          >(
            `SELECT id, idempotency_key, attempts, max_attempts FROM outbox ` +
              `WHERE status = 'pending' AND attempts >= max_attempts`,
          )
          .all();
        expect(
          stale.length,
          `NO_STALE_PENDING_OUTBOX violated:\n` +
            `  ${stale.length} outbox row(s) in 'pending' state with attempts >= max_attempts\n` +
            (stale.length > 0 && stale[0] !== undefined
              ? `  first: row ${stale[0].id} (${stale[0].idempotency_key}) ` +
                `attempts=${stale[0].attempts}/${stale[0].max_attempts}\n`
              : "") +
            `  => A row should have transitioned to 'failed' but is stuck.`,
        ).toBe(0);
      },
    },

    {
      name: "SQLITE_INTEGRITY",
      description: "PRAGMA integrity_check passes on all four databases",
      check: async (h: Harness): Promise<void> => {
        const dbs = [
          ["projection", h.projection.raw],
          ["answers", h.answers.raw],
          ["outbox", h.outbox.raw],
          ["ledger", h.ledger.raw],
        ] as const;
        for (const [name, db] of dbs) {
          const row = db
            .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
            .get();
          expect(
            row?.integrity_check,
            `SQLITE_INTEGRITY violated on ${name}.db: ${row?.integrity_check ?? "(no row)"}`,
          ).toBe("ok");
        }
      },
    },
  ]);

/**
 * Run every always-true invariant against the current harness state. On
 * violation, the originating `expect(...)` throws an `AssertionError`; we
 * re-wrap with a banner that names the triggering move so the test output
 * makes the failure context clear.
 */
export async function runAllAlwaysTrue(
  h: Harness,
  triggeringMove: string,
): Promise<void> {
  for (const inv of ALWAYS_TRUE_INVARIANTS) {
    try {
      await inv.check(h);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const wrapped = new Error(
        `\n=== Always-true invariant violated after move: ${triggeringMove} ===\n` +
          `Invariant: ${inv.name}\n` +
          `${msg}\n`,
      );
      // Preserve the original stack so the failure points at the
      // matcher call site, not this wrapper.
      if (e instanceof Error && e.stack !== undefined) {
        wrapped.stack = e.stack;
      }
      throw wrapped;
    }
  }
}
