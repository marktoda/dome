// Controlled mutation: one deep, recovery-backed seam for Dome-mediated
// working-tree writes. It composes the existing compiler-host exclusion,
// branch CAS, and finalize journal; it is not an engine primitive.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";
import { z } from "zod";

import {
  add,
  commitFilesOnHead,
  currentBranch,
  currentSha,
  isAncestor,
  readBlob,
  remove,
  type CommitIdentity,
} from "../git";
import {
  withCompilerHostBranchLock,
} from "../engine/host/compiler-host-lock";
import { withExclusiveFileLock } from "../engine/host/file-lock";
import {
  clearFinalizeJournal,
  replayFinalizeJournal,
  writeFinalizeJournal,
} from "../engine/core/finalize-journal";

const SCHEMA = "dome.controlled-mutation/v1";
export const CONTROLLED_MUTATION_TRAILER = "Dome-Request" as const;
const DEFAULT_WAIT = { timeoutMs: 5_000, intervalMs: 25 } as const;

const JournalSchema = z.object({
  schema: z.literal(SCHEMA),
  requestId: z.string().min(1),
  branch: z.string().min(1),
  sourceHead: z.string().regex(/^[0-9a-f]{40}$/),
  target: z.string().regex(/^[0-9a-f]{40}$/),
  writtenAt: z.string(),
  files: z.array(z.object({
    path: z.string().min(1),
    expectedContent: z.string().nullable(),
    content: z.string().nullable(),
  })).min(1),
});

type MutationJournal = z.infer<typeof JournalSchema>;

export type ControlledFileChange = {
  readonly path: string;
  readonly expectedContent: string | null;
  readonly content: string | null;
};

export type ControlledMutationResult =
  | {
      readonly kind: "committed";
      readonly requestId: string;
      readonly commit: string;
      readonly repairedPaths: ReadonlyArray<string>;
      readonly checkout: "repaired" | "superseded";
    }
  | {
      readonly kind: "no-commit";
      readonly requestId: string;
      readonly reason: "working-tree-conflict" | "candidate-not-landed" | "branch-mismatch";
      readonly paths: ReadonlyArray<string>;
    }
  | {
      readonly kind: "diverged";
      readonly requestId: string;
      readonly commit: string | null;
      readonly paths: ReadonlyArray<string>;
      readonly journalPath: string;
    }
  | {
      readonly kind: "busy";
      readonly requestId: string;
      readonly lockPath: string;
    };

export type ControlledMutationDeps = {
  /** Fault-injection seam: runs after the ref advances and before checkout repair. */
  readonly afterRefAdvance?: (commit: string) => Promise<void>;
  /** Test-only crash seam: false leaves durable journals for explicit recovery. */
  readonly reconcileAfterFailure?: boolean;
  readonly lockWait?: { readonly timeoutMs: number; readonly intervalMs: number };
  readonly now?: () => Date;
};

export async function applyControlledMutation(
  input: {
    readonly vaultPath: string;
    readonly branch: string;
    readonly requestId: string;
    readonly files: ReadonlyArray<ControlledFileChange>;
    readonly message: string;
    readonly author?: CommitIdentity;
  },
  deps: ControlledMutationDeps = {},
): Promise<ControlledMutationResult> {
  if (
    input.requestId.length === 0 ||
    input.requestId.length > 256 ||
    /[\r\n\0]/.test(input.requestId)
  ) {
    throw new Error("controlled mutation request id must be 1-256 single-line characters");
  }
  validateInput(input.files);
  const wait = deps.lockWait ?? DEFAULT_WAIT;
  const hostLocked = await withCompilerHostBranchLock(
    {
      vaultPath: input.vaultPath,
      branch: input.branch,
      command: `controlled-mutation:${input.requestId}`,
      wait,
    },
    async () => {
      const mutationLocked = await withExclusiveFileLock(
        {
          lockPath: mutationLockPath(input.vaultPath, input.branch),
          command: `controlled-mutation:${input.requestId}`,
          wait,
        },
        async () => applyWhileLocked(input, deps),
      );
      if (mutationLocked.kind === "busy") {
        return Object.freeze({
          kind: "busy" as const,
          requestId: input.requestId,
          lockPath: mutationLocked.lockPath,
        });
      }
      return mutationLocked.value;
    },
  );
  if (hostLocked.kind === "busy") {
    return Object.freeze({
      kind: "busy" as const,
      requestId: input.requestId,
      lockPath: hostLocked.lockPath,
    });
  }
  return hostLocked.value;
}

export async function recoverControlledMutation(input: {
  readonly vaultPath: string;
  readonly branch: string;
  readonly requestId?: string;
}): Promise<ControlledMutationResult | { readonly kind: "none" }> {
  const requestId = input.requestId ?? "recovery";
  const hostLocked = await withCompilerHostBranchLock(
    {
      vaultPath: input.vaultPath,
      branch: input.branch,
      command: `controlled-mutation-recovery:${requestId}`,
      wait: DEFAULT_WAIT,
    },
    async () => {
      const mutationLocked = await withExclusiveFileLock(
        {
          lockPath: mutationLockPath(input.vaultPath, input.branch),
          command: `controlled-mutation-recovery:${requestId}`,
          wait: DEFAULT_WAIT,
        },
        async () => {
          const replay = await replayFinalizeJournal(input.vaultPath);
          if (replay.kind === "replayed" && replay.skippedPaths.length > 0) {
            return Object.freeze({
              kind: "no-commit" as const,
              requestId,
              reason: "working-tree-conflict" as const,
              paths: replay.skippedPaths,
            });
          }
          return reconcileJournal(input.vaultPath, input.branch, requestId);
        },
      );
      return mutationLocked.kind === "busy"
        ? Object.freeze({ kind: "busy" as const, requestId, lockPath: mutationLocked.lockPath })
        : mutationLocked.value;
    },
  );
  return hostLocked.kind === "busy"
    ? Object.freeze({ kind: "busy" as const, requestId, lockPath: hostLocked.lockPath })
    : hostLocked.value;
}

async function applyWhileLocked(
  input: Parameters<typeof applyControlledMutation>[0],
  deps: ControlledMutationDeps,
): Promise<ControlledMutationResult> {
  const replay = await replayFinalizeJournal(input.vaultPath);
  if (replay.kind === "replayed" && replay.skippedPaths.length > 0) {
    return Object.freeze({
      kind: "no-commit" as const,
      requestId: input.requestId,
      reason: "working-tree-conflict" as const,
      paths: replay.skippedPaths,
    });
  }
  const prior = await reconcileJournal(input.vaultPath, input.branch, input.requestId);
  if (prior.kind === "diverged") return prior;

  if ((await currentBranch(input.vaultPath)) !== input.branch) {
    return Object.freeze({
      kind: "no-commit" as const,
      requestId: input.requestId,
      reason: "branch-mismatch" as const,
      paths: Object.freeze([] as string[]),
    });
  }

  const conflicts: string[] = [];
  for (const file of input.files) {
    if ((await readWorkingFile(input.vaultPath, file.path)) !== file.expectedContent) {
      conflicts.push(file.path);
    }
  }
  if (conflicts.length > 0) {
    return Object.freeze({
      kind: "no-commit" as const,
      requestId: input.requestId,
      reason: "working-tree-conflict" as const,
      paths: Object.freeze(conflicts),
    });
  }

  try {
    await commitFilesOnHead({
      path: input.vaultPath,
      files: input.files.map((file) => ({ filepath: file.path, content: file.content })),
      message: `${input.message.trimEnd()}\n\n${CONTROLLED_MUTATION_TRAILER}: ${input.requestId}`,
      ...(input.author !== undefined ? { author: input.author } : {}),
      onCandidate: async (candidate) => {
        const writtenAt = (deps.now ?? (() => new Date()))().toISOString();
        await writeMutationJournal(input.vaultPath, {
          schema: SCHEMA,
          requestId: input.requestId,
          branch: input.branch,
          sourceHead: candidate.head,
          target: candidate.commit,
          writtenAt,
          files: input.files.map((file) => ({ ...file })),
        });
        await writeFinalizeJournal(input.vaultPath, {
          branch: input.branch,
          sourceHead: candidate.head,
          target: candidate.commit,
          paths: input.files.map((file) => file.path),
          writtenAt,
        });
      },
      ...(deps.afterRefAdvance !== undefined
        ? { afterRefAdvance: deps.afterRefAdvance }
        : {}),
    });
  } catch (error) {
    // The durable journals determine whether the candidate landed. Reconcile
    // instead of guessing from the thrown phase.
    if (deps.reconcileAfterFailure === false) throw error;
  }

  await replayFinalizeJournal(input.vaultPath);
  const reconciled = await reconcileJournal(
    input.vaultPath,
    input.branch,
    input.requestId,
  );
  return reconciled.kind === "none"
    ? Object.freeze({
        kind: "no-commit" as const,
        requestId: input.requestId,
        reason: "candidate-not-landed" as const,
        paths: Object.freeze([] as string[]),
      })
    : reconciled;
}

async function reconcileJournal(
  vaultPath: string,
  branch: string,
  fallbackRequestId: string,
): Promise<ControlledMutationResult | { readonly kind: "none" }> {
  const loaded = await readMutationJournal(vaultPath, branch);
  if (loaded.kind === "none") return loaded;
  if (loaded.kind === "invalid") {
    return divergence(vaultPath, branch, fallbackRequestId, null, []);
  }
  const journal = loaded.journal;
  const head = await currentSha(vaultPath);
  const landed = head !== null && (
    head === journal.target ||
    await isAncestor({ path: vaultPath, ancestor: journal.target, descendant: head })
  );
  if (!landed || head === null) {
    await clearMutationJournal(vaultPath, branch);
    await clearFinalizeJournal(vaultPath);
    return Object.freeze({
      kind: "no-commit" as const,
      requestId: journal.requestId,
      reason: "candidate-not-landed" as const,
      paths: Object.freeze([]),
    });
  }

  // A later commit may legitimately supersede this request. Do not restore an
  // older desired blob over the branch's newer truth.
  for (const file of journal.files) {
    const headContent = await readBlob({ path: vaultPath, commit: head, filepath: file.path });
    if (headContent !== file.content) {
      await clearMutationJournal(vaultPath, branch);
      return Object.freeze({
        kind: "committed" as const,
        requestId: journal.requestId,
        commit: journal.target,
        repairedPaths: Object.freeze([]),
        checkout: "superseded" as const,
      });
    }
  }

  const divergedPaths: string[] = [];
  const repairedPaths: string[] = [];
  for (const file of journal.files) {
    const current = await readWorkingFile(vaultPath, file.path);
    if (current === file.content) continue;
    if (current !== file.expectedContent) {
      divergedPaths.push(file.path);
      continue;
    }
    await materialize(vaultPath, file.path, file.content);
    repairedPaths.push(file.path);
  }
  if (divergedPaths.length > 0) {
    return divergence(vaultPath, branch, journal.requestId, journal.target, divergedPaths);
  }

  for (const file of journal.files) {
    try {
      if (file.content === null) await remove(vaultPath, file.path);
      else await add(vaultPath, file.path);
    } catch {
      // The working bytes and branch are already correct. A stale index is
      // observable and repairable; it cannot justify overwriting owner bytes.
    }
  }
  await clearMutationJournal(vaultPath, branch);
  await clearFinalizeJournal(vaultPath);
  return Object.freeze({
    kind: "committed" as const,
    requestId: journal.requestId,
    commit: journal.target,
    repairedPaths: Object.freeze(repairedPaths),
    checkout: "repaired" as const,
  });
}

function divergence(
  vaultPath: string,
  branch: string,
  requestId: string,
  commit: string | null,
  paths: ReadonlyArray<string>,
): ControlledMutationResult {
  return Object.freeze({
    kind: "diverged" as const,
    requestId,
    commit,
    paths: Object.freeze([...paths]),
    journalPath: mutationJournalPath(vaultPath, branch),
  });
}

async function materialize(
  vaultPath: string,
  path: string,
  content: string | null,
): Promise<void> {
  const absolute = join(vaultPath, path);
  if (content === null) {
    await rm(absolute, { force: true });
    return;
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function readWorkingFile(vaultPath: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(vaultPath, path), "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function validateInput(files: ReadonlyArray<ControlledFileChange>): void {
  if (files.length === 0) throw new Error("controlled mutation requires at least one file");
  const seen = new Set<string>();
  for (const file of files) {
    const normalized = posix.normalize(file.path);
    if (
      file.path.length === 0 ||
      isAbsolute(file.path) ||
      normalized !== file.path ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      file.path.startsWith(".dome/") ||
      seen.has(file.path)
    ) {
      throw new Error(`invalid controlled mutation path: ${file.path}`);
    }
    seen.add(file.path);
  }
}

export function mutationJournalPath(vaultPath: string, branch: string): string {
  return join(vaultPath, ".dome", "state", "mutations", `${encodeBranch(branch)}.json`);
}

function mutationLockPath(vaultPath: string, branch: string): string {
  return join(vaultPath, ".dome", "state", "locks", `${encodeBranch(branch)}.mutation.lock`);
}

async function writeMutationJournal(vaultPath: string, journal: MutationJournal): Promise<void> {
  const path = mutationJournalPath(vaultPath, journal.branch);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function readMutationJournal(
  vaultPath: string,
  branch: string,
): Promise<
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly journal: MutationJournal }
> {
  try {
    const parsed = JournalSchema.safeParse(JSON.parse(
      await readFile(mutationJournalPath(vaultPath, branch), "utf8"),
    ));
    return parsed.success
      ? { kind: "valid", journal: parsed.data }
      : { kind: "invalid" };
  } catch (error) {
    return hasCode(error, "ENOENT") ? { kind: "none" } : { kind: "invalid" };
  }
}

async function clearMutationJournal(vaultPath: string, branch: string): Promise<void> {
  await rm(mutationJournalPath(vaultPath, branch), { force: true });
}

function encodeBranch(branch: string): string {
  return Buffer.from(branch, "utf8").toString("base64url");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
