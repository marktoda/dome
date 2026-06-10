// Finalize-intent journal — crash-safety for adoption finalization.
//
// `adopt()`'s finalization sequence is: advance `refs/heads/<branch>` to the
// engine target, materialize the changed paths into the working tree, then
// advance the adopted ref. A throw inside that sequence is rolled back
// in-process, but a process *crash* between the branch advance and the
// materialization used to be unrecoverable: the next tick saw in-sync refs,
// skipped materialization, and the stale working-tree content read as
// phantom user edits that could be committed — silently reverting the
// engine's adopted change.
//
// The journal closes that window. Immediately before the branch advance the
// engine writes `.dome/state/finalize-intent.json` (atomic temp+rename)
// naming the branch, both sides of the move, and the affected paths. The
// journal is cleared once finalization fully resolves — success, or a
// completed rollback. On the next compiler-host tick, a surviving journal is
// replayed: whichever side the branch ref settled on, affected paths whose
// working-tree content still matches the *other* side (or is missing) are
// re-materialized; paths with content matching neither side are left alone
// (a human touched them after the crash — they surface as ordinary dirty
// files rather than being clobbered).

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { add, readBlob, readRef } from "../../git";

const FINALIZE_JOURNAL_SCHEMA = "dome.finalize-intent/v1";

const FinalizeJournalSchema = z.object({
  schema: z.literal(FINALIZE_JOURNAL_SCHEMA),
  branch: z.string().min(1),
  sourceHead: z.string().regex(/^[0-9a-f]{40}$/),
  target: z.string().regex(/^[0-9a-f]{40}$/),
  paths: z.array(z.string().min(1)),
  writtenAt: z.string(),
});

export type FinalizeJournal = z.infer<typeof FinalizeJournalSchema>;

export type FinalizeReplayResult =
  | { readonly kind: "none" }
  | { readonly kind: "cleared-invalid" }
  | { readonly kind: "superseded" }
  | {
      readonly kind: "replayed";
      readonly settled: "target" | "source-head";
      readonly restoredPaths: ReadonlyArray<string>;
      readonly skippedPaths: ReadonlyArray<string>;
    };

export function finalizeJournalPath(vaultPath: string): string {
  return join(vaultPath, ".dome", "state", "finalize-intent.json");
}

/**
 * Atomically persist the finalize intent before the branch advance. Throws
 * on I/O failure — callers must refuse to advance refs when the intent
 * cannot be made durable, because the crash window would otherwise reopen.
 */
export async function writeFinalizeJournal(
  vaultPath: string,
  entry: {
    readonly branch: string;
    readonly sourceHead: string;
    readonly target: string;
    readonly paths: ReadonlyArray<string>;
    readonly writtenAt: string;
  },
): Promise<void> {
  const journal: FinalizeJournal = {
    schema: FINALIZE_JOURNAL_SCHEMA,
    branch: entry.branch,
    sourceHead: entry.sourceHead,
    target: entry.target,
    paths: [...entry.paths],
    writtenAt: entry.writtenAt,
  };
  const path = finalizeJournalPath(vaultPath);
  const dir = join(vaultPath, ".dome", "state");
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** Remove the journal. Idempotent; swallows a missing file. */
export async function clearFinalizeJournal(vaultPath: string): Promise<void> {
  await rm(finalizeJournalPath(vaultPath), { force: true });
}

/**
 * Replay a surviving finalize intent, repairing the working tree to match
 * whichever side of the move the branch ref settled on. Conservative by
 * construction: a path whose current content matches neither side of the
 * move is left untouched and reported in `skippedPaths`.
 */
export async function replayFinalizeJournal(
  vaultPath: string,
): Promise<FinalizeReplayResult> {
  const file = Bun.file(finalizeJournalPath(vaultPath));
  if (!(await file.exists())) return Object.freeze({ kind: "none" as const });

  let journal: FinalizeJournal;
  try {
    journal = FinalizeJournalSchema.parse(JSON.parse(await file.text()));
  } catch {
    await clearFinalizeJournal(vaultPath);
    return Object.freeze({ kind: "cleared-invalid" as const });
  }

  const head = await readRef({
    path: vaultPath,
    ref: `refs/heads/${journal.branch}`,
  });
  if (head === null || (head !== journal.target && head !== journal.sourceHead)) {
    // The branch moved past both sides of the journaled advance (a later
    // adoption or a human moved it), or no longer exists. Whatever owns the
    // branch now owns the working tree; the intent is stale.
    await clearFinalizeJournal(vaultPath);
    return Object.freeze({ kind: "superseded" as const });
  }

  const settledSha = head;
  const otherSha = head === journal.target ? journal.sourceHead : journal.target;
  const restoredPaths: string[] = [];
  const skippedPaths: string[] = [];

  for (const path of journal.paths) {
    const settledContent = await readBlob({
      path: vaultPath,
      commit: settledSha,
      filepath: path,
    });
    const workingFile = Bun.file(join(vaultPath, path));
    const currentContent = (await workingFile.exists())
      ? await workingFile.text()
      : null;

    if (currentContent === settledContent) continue; // already consistent

    const otherContent = await readBlob({
      path: vaultPath,
      commit: otherSha,
      filepath: path,
    });
    if (currentContent !== otherContent && currentContent !== null) {
      // Content matches neither side of the move: a human edited the file
      // after the crash. Preserve it; it surfaces as an ordinary dirty file.
      skippedPaths.push(path);
      continue;
    }

    if (settledContent === null) {
      await rm(join(vaultPath, path), { force: true });
    } else {
      // Write the blob content directly rather than via checkout:
      // isomorphic-git's checkout skips a file whose index entry already
      // matches the target ref — which is exactly the crash-window state
      // (index at target, working tree at source).
      await mkdir(dirname(join(vaultPath, path)), { recursive: true });
      await writeFile(join(vaultPath, path), settledContent, "utf8");
      try {
        await add(vaultPath, path);
      } catch {
        // Index sync is best-effort; the working-tree repair above is the
        // correctness fix, and a stale index entry surfaces as ordinary
        // dirty status.
      }
    }
    restoredPaths.push(path);
  }

  await clearFinalizeJournal(vaultPath);
  return Object.freeze({
    kind: "replayed" as const,
    settled: head === journal.target ? ("target" as const) : ("source-head" as const),
    restoredPaths: Object.freeze(restoredPaths),
    skippedPaths: Object.freeze(skippedPaths),
  });
}
