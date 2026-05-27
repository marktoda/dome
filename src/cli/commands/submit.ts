// cli/commands/submit: the `dome submit` command.
//
// Per [[wiki/specs/cli]] §"dome submit", the full surface accepts:
//
//   dome submit [--patch <file>] [--source-kind <k>] [--metadata-title <s>]
//               [--metadata-reason <s>]
//
// Phase 9 ships a strict subset:
//
//   dome submit [--branch <branch>] [--metadata-title <s>] [--metadata-reason <s>]
//
// The `--patch` flow (apply a unified diff to a candidate tree, then
// submit) is deferred — it requires the candidate-tree mutator the
// Phase 7a `applyPatch` placeholder leaves unwired. The current flow
// submits the working-tree HEAD against the adopted ref:
//
//   base := refs/dome/adopted/<branch> (or HEAD when uninitialized;
//           `compileRange(head, head)` is an empty-signal no-op that
//           still advances the adopted ref to head)
//   head := the current HEAD on the branch
//   source := clientProposal({ clientId: "dome-cli" })
//
// If `--patch` is passed, we surface a clear "not yet wired in Phase 9"
// error and exit non-zero rather than silently submitting nothing.
//
// Exit codes:
//   - 0 on adoption success (`AdoptionResult.adopted === true`).
//   - 1 on blocked / failed adoption or runtime errors.
//   - 64 (EX_USAGE) on malformed flags / missing vault.
//
// House-style notes:
//   - Open the runtime; submit; print result; close. No persistent state.
//   - Read base/head via the live git boundary (`src/git`) + adopted-ref
//     accessors. Never reaches into `.git/` directly.

import { resolve } from "node:path";

import {
  clientProposal,
  makeProposalId,
  proposalMetadata,
  type AdoptionResult,
  type ProposalMetadata,
} from "../../core/proposal";
import { commitOid } from "../../core/source-ref";
import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import { currentSha } from "../../git";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { submitProposal } from "../../engine/submit-proposal";

import type { ParsedArgs } from "../args";
import { formatJson } from "../format";

// ----- runSubmit ------------------------------------------------------------

/**
 * Execute `dome submit`. Composes:
 *
 *   1. Resolve the vault path (cwd or `--vault <path>`).
 *   2. Resolve `(branch, base, head)`:
 *        - `branch` from `--branch <name>` or the current branch.
 *        - `head` from `git rev-parse HEAD`.
 *        - `base` from `refs/dome/adopted/<branch>` or `head` when
 *          uninitialized (the empty-diff initialization fallback).
 *   3. Construct a `clientProposal` from the resolved triple.
 *   4. Open the runtime, submit, print the result.
 *
 * Returns the exit code.
 */
export async function runSubmit(args: ParsedArgs): Promise<number> {
  // 1. Reject --patch with a clear "not yet wired" message. A future
  //    phase adds the candidate-tree mutator; Phase 9 cannot fabricate
  //    a head SHA from a patch file alone.
  if (typeof args.flags["patch"] === "string") {
    console.error(
      "dome submit: --patch is not yet wired in Phase 9. Commit your changes and re-run `dome submit` to submit the current HEAD.",
    );
    return 1;
  }

  // 2. Resolve the vault path. `--vault <path>` overrides the cwd.
  const vaultFlag = args.flags["vault"];
  const vaultPath = resolve(
    typeof vaultFlag === "string" ? vaultFlag : process.cwd(),
  );

  // 3. Resolve the branch + commit-OID triple.
  const branchFlag = args.flags["branch"];
  const branch =
    typeof branchFlag === "string"
      ? branchFlag
      : await getCurrentBranch(vaultPath);
  if (branch === null) {
    console.error(
      "dome submit: HEAD is detached and no --branch override was supplied. Check out a branch or pass --branch <name>.",
    );
    return 1;
  }

  const head = await currentSha(vaultPath);
  if (head === null) {
    console.error(
      `dome submit: vault at ${vaultPath} has no HEAD commit. Make at least one commit before submitting.`,
    );
    return 1;
  }

  const adopted = await getAdoptedRef(vaultPath, branch);
  // When the adopted ref is uninitialized, the safe Phase 9 fallback is
  // `base = head`. `compileRange(head, head)` produces an empty diff;
  // the adoption loop converges on iteration 1 with no processor runs
  // and the adopted ref advances to `head` as the initialization step.
  // A future phase wires the "first adoption" path that synthesizes a
  // full-tree initial diff from a synthetic zero base; today,
  // `compileRange` calls `readTree(ZERO_SHA)` which the git boundary
  // rejects, so the empty-diff fallback is the cleanest v1 surface.
  const base = adopted ?? head;

  if (base === head && adopted !== null) {
    console.log(
      `dome submit: adopted ref already at ${head.slice(0, 7)} on ${branch} — nothing to submit.`,
    );
    return 0;
  }

  // 4. Construct the Proposal. clientId is a fixed marker for the CLI
  //    so the run ledger can attribute submissions to the cli surface.
  const metadata = buildMetadata(args);
  const proposal =
    metadata === undefined
      ? clientProposal({
          id: makeProposalId(),
          base: commitOid(base),
          head: commitOid(head),
          clientId: "dome-cli",
        })
      : clientProposal({
          id: makeProposalId(),
          base: commitOid(base),
          head: commitOid(head),
          clientId: "dome-cli",
          metadata,
        });

  // 5. Open the runtime against the vault's installed bundles.
  // `--bundles-root <path>` overrides the default; useful for tests
  // pointing at the shipped assets/extensions/ tree.
  const bundlesRootFlag = args.flags["bundles-root"];
  const bundlesRoot =
    typeof bundlesRootFlag === "string"
      ? bundlesRootFlag
      : `${vaultPath}/.dome/extensions`;
  const runtimeResult = await openVaultRuntime({
    vaultPath,
    bundlesRoot,
  });
  if (!runtimeResult.ok) {
    const e = runtimeResult.error;
    console.error(
      `dome submit: openVaultRuntime failed (${e.kind}). Make sure ${vaultPath}/.dome/extensions/ exists (run \`dome init\` first).`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    // 6. Submit. The result discriminates adopted/blocked via `adopted`.
    const result = await submitProposal({ runtime, proposal });
    printAdoptionResult(result, args);
    return result.adopted ? 0 : 1;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome submit: submission threw: ${msg}`);
    return 1;
  } finally {
    await runtime.close();
  }
}

// ----- internals ------------------------------------------------------------

/**
 * Build the optional `metadata` field for `clientProposal`. Returns
 * `undefined` when neither `--metadata-title` nor `--metadata-reason`
 * was supplied (the caller branches and omits the `metadata` key
 * entirely — matches `exactOptionalPropertyTypes`).
 */
function buildMetadata(args: ParsedArgs): ProposalMetadata | undefined {
  const titleFlag = args.flags["metadata-title"];
  const reasonFlag = args.flags["metadata-reason"];
  const title = typeof titleFlag === "string" ? titleFlag : undefined;
  const reason = typeof reasonFlag === "string" ? reasonFlag : undefined;
  if (title === undefined && reason === undefined) return undefined;

  const input: { title?: string; reason?: string } = {};
  if (title !== undefined) input.title = title;
  if (reason !== undefined) input.reason = reason;
  return proposalMetadata(input);
}

/**
 * Print the AdoptionResult. `--json` emits the full result as JSON;
 * otherwise renders a 4-line summary plus per-diagnostic detail.
 */
function printAdoptionResult(result: AdoptionResult, args: ParsedArgs): void {
  if (args.flags["json"] === true) {
    console.log(formatJson(result));
    return;
  }

  console.log(`dome submit: ${result.adopted ? "adopted" : "blocked"}`);
  console.log(`  proposal:    ${result.proposalId}`);
  console.log(`  adopted-ref: ${result.adoptedRef.slice(0, 7)}`);
  console.log(
    `  closure:     ${result.closureCommitOid === null ? "(none)" : result.closureCommitOid.slice(0, 7)}`,
  );
  console.log(`  iterations:  ${result.iterations}`);

  if (result.diagnostics.length === 0) return;
  console.log(`  diagnostics:`);
  for (const d of result.diagnostics) {
    console.log(`    [${d.severity}] ${d.code}: ${d.message}`);
  }
}
