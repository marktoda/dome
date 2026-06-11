// cli/commands/reanchor: explicit adopted-ref divergence recovery.
//
// Per docs/wiki/specs/cli.md §"dome reanchor" and
// docs/wiki/gotchas/adopted-ref-divergence.md, `dome reanchor` is the ONE
// user-facing path that moves `refs/dome/adopted/<branch>` without a
// fast-forward. It exists for exactly one state: the branch history was
// rewritten under the adopted cursor (force-push, hard-reset, rebase) and the
// operator has confirmed the new HEAD is the intended trunk.
//
// Safety posture:
//   - Refuses (exit 64) when the adopted ref is NOT diverged — a clean vault
//     must never grow a habit of force-moving the cursor; `dome sync` is the
//     only advance path there.
//   - Records the old adopted SHA in the command output AND in a backup ref
//     `refs/dome/backup/adopted-<timestamp>` before moving, so the orphaned
//     engine/human commits stay reachable (no GC) and the move is reversible.
//   - After moving, runs one normal compiler-host tick so adoption/operational
//     work resumes immediately on the re-anchored baseline.
//
// House-style notes (matches src/cli/commands/rebuild.ts):
//   - The handler returns the exit code; the dispatcher calls `process.exit`.
//   - `--json` emits a single `dome.reanchor/v1` object on stdout.

import { basename } from "node:path";

import {
  getAdoptedRef,
  getCurrentBranch,
  setAdoptedRef,
} from "../../adopted-ref";
import {
  currentSha,
  isAncestor,
  readRef,
  writeRef,
} from "../../git";
import {
  detectDrift,
  runCompilerHostTick,
} from "../../engine/host/compiler-host";
import { openVaultRuntime } from "../../engine/host/vault-runtime";
import { formatJson } from "../../surface/format";
import {
  footer,
  headline,
  kv,
  resolveCaps,
  section,
  type KvRow,
} from "../presenter";
import { resolveBundleRoots } from "./sync-shared";

import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";
const SCHEMA = "dome.reanchor/v1";

export type RunReanchorOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  /** Commit OID to re-anchor to. Defaults to the current HEAD. */
  readonly to?: string | undefined;
  readonly json?: boolean | undefined;
};

type ReanchorJsonResult =
  | {
      readonly schema: typeof SCHEMA;
      readonly status: "reanchored";
      readonly vault: string;
      readonly branch: string;
      readonly head: string;
      readonly previous_adopted: string;
      readonly new_adopted: string;
      readonly backup_ref: string;
      readonly sync: {
        readonly kind: string;
        readonly final_adopted: string | null;
      };
    }
  | {
      readonly schema: typeof SCHEMA;
      readonly status: "error";
      readonly vault: string;
      readonly branch: string | null;
      readonly head: string | null;
      readonly adopted: string | null;
      readonly error: string;
      readonly message: string;
    };

/**
 * Execute `dome reanchor`. Returns the exit code: 0 when the adopted ref was
 * re-anchored (and the follow-up tick ran); 64 (EX_USAGE) when the vault is
 * not in the diverged state this command exists for (detached HEAD, no
 * commits, uninitialized adopted ref, not diverged, or a `--to` target that
 * is not reachable from HEAD); 1 on runtime-open or ref-write failure.
 */
export async function runReanchor(
  options: RunReanchorOptions = {},
): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const json = options.json === true;

  const branch = await getCurrentBranch(vaultPath);
  if (branch === null) {
    return emitError({
      json,
      vaultPath,
      branch: null,
      head: null,
      adopted: null,
      error: "detached-head",
      message:
        "HEAD is detached; the adopted-ref substrate requires a branch. " +
        "Check out a branch and retry.",
    });
  }
  const head = await currentSha(vaultPath);
  if (head === null) {
    return emitError({
      json,
      vaultPath,
      branch,
      head: null,
      adopted: null,
      error: "no-commits",
      message: "vault has no commits yet; nothing to reanchor.",
    });
  }
  const adopted = await getAdoptedRef(vaultPath, branch);
  if (adopted === null) {
    return emitError({
      json,
      vaultPath,
      branch,
      head,
      adopted: null,
      error: "adopted-ref-uninitialized",
      message:
        `adopted ref for ${branch} is uninitialized; nothing to reanchor. ` +
        "Run `dome sync` to initialize it.",
    });
  }

  // The diverged gate: reanchor exists only for the rewritten-history state.
  // When adopted is HEAD or an ancestor of HEAD, the normal fast-forward path
  // (`dome sync`) is the only legitimate advance.
  const diverged =
    adopted !== head &&
    !(await isAncestor({ path: vaultPath, ancestor: adopted, descendant: head }));
  if (!diverged) {
    return emitError({
      json,
      vaultPath,
      branch,
      head,
      adopted,
      error: "not-diverged",
      message:
        `adopted ref for ${branch} (${adopted.slice(0, 7)}) is ` +
        `${adopted === head ? "already at HEAD" : "an ancestor of HEAD"}; ` +
        "not diverged. Run `dome sync` for normal fast-forward adoption.",
    });
  }

  const target = options.to ?? head;
  // The new anchor must be on the rewritten branch: HEAD itself or one of its
  // ancestors. Anything else would immediately re-create the divergence.
  const targetOnBranch =
    target === head ||
    (await isAncestor({ path: vaultPath, ancestor: target, descendant: head }));
  if (!targetOnBranch) {
    return emitError({
      json,
      vaultPath,
      branch,
      head,
      adopted,
      error: "target-not-on-branch",
      message:
        `--to ${target} is not HEAD or an ancestor of HEAD ` +
        `(${head.slice(0, 7)}); the new anchor must be a full commit OID on ` +
        "the current branch.",
    });
  }

  // Open the runtime BEFORE mutating any ref, so a misconfigured vault
  // refuses without leaving a half-done recovery behind.
  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    return emitError({
      json,
      vaultPath,
      branch,
      head,
      adopted,
      error: `runtime-open-failed:${runtimeResult.error.kind}`,
      message:
        `openVaultRuntime failed (${runtimeResult.error.kind}). ` +
        "Run `dome init` to initialize the vault.",
      exitCode: 1,
    });
  }
  const runtime = runtimeResult.value;

  try {
    // Backup ref first: the old adopted SHA must stay reachable before the
    // cursor moves, so an interrupted reanchor never strands the orphaned
    // engine/human commits.
    const backupRef = await writeBackupRef({ vaultPath, adopted });

    const moved = await setAdoptedRef(vaultPath, branch, target, {
      forceAdvance: true,
    });
    if (!moved.ok) {
      return emitError({
        json,
        vaultPath,
        branch,
        head,
        adopted,
        error: "adopted-ref-write-failed",
        message: moved.error.message,
        exitCode: 1,
      });
    }

    // Normal sync path: one compiler-host tick against the re-anchored
    // cursor. target === HEAD lands in-sync (operational drain); an
    // ancestor target adopts the remaining range immediately.
    const drift = await detectDrift(vaultPath);
    const tick = await runCompilerHostTick({ runtime, drift });
    const finalAdopted =
      "finalAdoptedRef" in tick ? tick.finalAdoptedRef : null;

    if (json) {
      const payload: ReanchorJsonResult = {
        schema: SCHEMA,
        status: "reanchored",
        vault: vaultPath,
        branch,
        head,
        previous_adopted: adopted,
        new_adopted: target,
        backup_ref: backupRef,
        sync: {
          kind: tick.kind,
          final_adopted: finalAdopted,
        },
      };
      console.log(formatJson(payload));
    } else {
      printReanchorText({
        vaultPath,
        branch,
        previousAdopted: adopted,
        newAdopted: target,
        backupRef,
        tickKind: tick.kind,
        finalAdopted,
      });
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

// ----- internals ------------------------------------------------------------

/**
 * Write `refs/dome/backup/adopted-<timestamp>` at the old adopted SHA. The
 * timestamp is a ref-safe UTC `YYYYMMDDTHHMMSSZ`; same-second collisions get
 * a `-2`, `-3`, ... suffix instead of overwriting an earlier backup.
 */
async function writeBackupRef(opts: {
  readonly vaultPath: string;
  readonly adopted: string;
}): Promise<string> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const base = `refs/dome/backup/adopted-${stamp}`;
  let ref = base;
  for (let suffix = 2; ; suffix++) {
    const existing = await readRef({ path: opts.vaultPath, ref });
    if (existing === null || existing === opts.adopted) break;
    ref = `${base}-${suffix}`;
  }
  await writeRef({ path: opts.vaultPath, ref, value: opts.adopted });
  return ref;
}

function printReanchorText(input: {
  readonly vaultPath: string;
  readonly branch: string;
  readonly previousAdopted: string;
  readonly newAdopted: string;
  readonly backupRef: string;
  readonly tickKind: string;
  readonly finalAdopted: string | null;
}): void {
  const caps = resolveCaps();
  const rows: KvRow[] = [
    { label: "branch", value: input.branch },
    {
      label: "previous adopted",
      value: input.previousAdopted.slice(0, 7),
      tone: "ident",
    },
    {
      label: "new adopted",
      value: input.newAdopted.slice(0, 7),
      tone: "ident",
    },
    { label: "backup ref", value: input.backupRef, tone: "muted" },
    {
      label: "sync",
      value:
        input.finalAdopted === null
          ? input.tickKind
          : `${input.tickKind} (adopted ${input.finalAdopted.slice(0, 7)})`,
    },
  ];
  const lines = [
    headline(
      { cmd: "reanchor", context: basename(input.vaultPath) },
      { tone: "ok", label: "reanchored" },
      caps,
    ),
    ...section("Reanchor", kv(rows, caps), caps),
    ...footer({ tone: "ok", label: "reanchored" }, caps),
  ];
  console.log(lines.join("\n"));
}

function emitError(opts: {
  readonly json: boolean;
  readonly vaultPath: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly adopted: string | null;
  readonly error: string;
  readonly message: string;
  readonly exitCode?: number;
}): number {
  if (opts.json) {
    const payload: ReanchorJsonResult = {
      schema: SCHEMA,
      status: "error",
      vault: opts.vaultPath,
      branch: opts.branch,
      head: opts.head,
      adopted: opts.adopted,
      error: opts.error,
      message: opts.message,
    };
    console.log(formatJson(payload));
  } else {
    console.error(`dome reanchor: ${opts.message}`);
  }
  return opts.exitCode ?? EX_USAGE;
}
