import { unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, type Effect, type ToolReturn } from "../types";
import type { Vault } from "../vault";
import { type Dispatcher, refuseIfDispatcherOwned } from "../dispatcher";
import { refuseIfRawImmutable, checkOptimisticLock, logMutation } from "./guards";

export interface DeleteDocumentInput {
  path: string;
  reason: string;
  /**
   * Optimistic-locking snapshot (typically threaded from a prior
   * readDocument's Document.mtime). When set, the Tool re-reads the file's
   * mtime immediately before unlinking and returns concurrent-write-conflict
   * if it has changed. Omit for "last write wins".
   * See docs/wiki/specs/sdk-surface.md §Concurrency.
   */
  expected_mtime?: string;
}

export async function deleteDocument(
  vault: Vault,
  dispatcher: Dispatcher,
  input: DeleteDocumentInput
): Promise<ToolReturn<void>> {
  const ownedErr = refuseIfDispatcherOwned(input.path, "deleteDocument");
  if (ownedErr) return { result: err(ownedErr), effects: [] };

  const rawErr = refuseIfRawImmutable(input.path, "deleteDocument");
  if (rawErr) return { result: err(rawErr), effects: [] };

  const abs = join(vault.path, input.path);
  try {
    await access(abs);
  } catch {
    return { result: err({ kind: "not-found", path: input.path }), effects: [] };
  }

  // Optimistic-locking re-check (only fires when the caller threaded
  // expected_mtime from a prior readDocument).
  const lockErr = await checkOptimisticLock(abs, input.path, input.expected_mtime);
  if (lockErr) return { result: err(lockErr), effects: [] };

  await unlink(abs);

  const effects: Effect[] = [{ kind: "deleted-document", path: input.path }];
  const logEffect = await logMutation(vault, dispatcher, {
    verb: "update",
    subject: `delete ${input.path}`,
    body: input.reason,
  });
  if (logEffect) effects.push(logEffect);
  return { result: ok(undefined), effects };
}
