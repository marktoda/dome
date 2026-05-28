// cli/commands/status: the `dome status [--json]` command.
//
// Per [[wiki/specs/cli]] §"dome status", a read-only snapshot of the
// vault's adoption state. Phase 9 prints:
//
//   - branch:          the current git branch (`currentBranch`).
//   - head:            the current HEAD commit OID (`currentSha`).
//   - adopted:         `refs/dome/adopted/<branch>` value, or "(uninitialized)".
//   - last_sync:       `started_at` of the most recent succeeded run
//                      (max startedAt across queryRuns status=succeeded).
//   - pending_runs:    count of ledger rows in `status='queued'`.
//
// All values are derived from existing v1 read surfaces — `src/git`,
// `src/adopted-ref`, `src/ledger/runs`. The command opens the runtime
// (only to read the ledger), does not submit a Proposal, and closes on
// exit. Exit codes:
//   - 0 on a clean read.
//   - 1 if the vault is malformed (no git repo, runtime open failure).
//
// House-style notes:
//   - `--json` emits the snapshot as a JSON object. The text mode
//     renders a key-aligned summary (no table — only one row).

import { resolve } from "node:path";

import { currentSha } from "../../git";
import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { queryRuns } from "../../ledger/runs";

import { resolveShippedBundlesRoot } from "./sync-shared";

import type { ParsedArgs } from "../args";
import { formatJson } from "../format";

// ----- Public types ---------------------------------------------------------

/**
 * The status snapshot. All fields are `string | null` so a JSON emit
 * has stable keys regardless of vault state.
 */
type StatusSnapshot = {
  readonly vault: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly adopted: string | null;
  readonly last_sync: string | null;
  readonly pending_runs: number;
};

// ----- runStatus ------------------------------------------------------------

/**
 * Execute `dome status`. Returns the exit code.
 */
export async function runStatus(args: ParsedArgs): Promise<number> {
  const vaultFlag = args.flags["vault"];
  const vaultPath = resolve(
    typeof vaultFlag === "string" ? vaultFlag : process.cwd(),
  );

  // Read the git-side state first. These accessors return null on missing
  // / detached HEAD / uninitialized adopted ref — all valid states.
  const branch = await getCurrentBranch(vaultPath);
  const head = await currentSha(vaultPath);
  const adopted = branch === null ? null : await getAdoptedRef(vaultPath, branch);

  // Open the runtime to read the ledger. If the runtime can't open (no
  // .dome/extensions/, missing bundles), surface a useful error and exit
  // non-zero — the ledger is part of the snapshot.
  //
  // Default `bundlesRoot` is the SDK's shipped first-party bundles
  // (`resolveShippedBundlesRoot`). The vault-local `.dome/extensions/`
  // is no longer the default; `--bundles-root <path>` overrides.
  const bundlesRootFlag = args.flags["bundles-root"];
  const bundlesRoot =
    typeof bundlesRootFlag === "string"
      ? bundlesRootFlag
      : resolveShippedBundlesRoot();
  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    console.error(
      `dome status: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    // Most recent succeeded run, ordered by started_at desc (the
    // `queryRuns` default ordering). The limit-1 cap keeps the read
    // cheap; the result either has one row (the most recent succeeded
    // run) or is empty (no successful adoption yet).
    const recent = queryRuns(runtime.ledgerDb, {
      status: "succeeded",
      limit: 1,
    });
    const last_sync = recent[0]?.startedAt ?? null;

    // Pending = queued. The dispatcher should drain queued rows quickly;
    // a persistently non-zero count is a "stuck" indicator the operator
    // surfaces via `dome doctor --show runs`.
    const queued = queryRuns(runtime.ledgerDb, { status: "queued" });
    const pending_runs = queued.length;

    const snapshot: StatusSnapshot = {
      vault: vaultPath,
      branch,
      head,
      adopted,
      last_sync,
      pending_runs,
    };

    if (args.flags["json"] === true) {
      console.log(formatJson(snapshot));
    } else {
      printStatusText(snapshot);
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

// ----- internals ------------------------------------------------------------

/**
 * Render the snapshot as a multi-line key-aligned summary.
 * Mirrors the `dome stats` output shape from the CLI spec, scaled
 * down to the Phase 9 surface.
 */
function printStatusText(s: StatusSnapshot): void {
  console.log(`vault:        ${s.vault}`);
  console.log(`  branch:     ${s.branch ?? "(detached)"}`);
  console.log(`  head:       ${s.head === null ? "(none)" : s.head.slice(0, 7)}`);
  console.log(
    `  adopted:    ${s.adopted === null ? "(uninitialized)" : s.adopted.slice(0, 7)}`,
  );
  console.log(`  last_sync:  ${s.last_sync ?? "(never)"}`);
  console.log(`  pending:    ${s.pending_runs}`);
}
