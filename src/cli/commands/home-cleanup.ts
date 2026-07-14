// cli/commands/home-cleanup: presentation Adapter over the single host-wide
// manual cleanup interface.

import { formatJson } from "../../surface/format";
import {
  HOME_RELEASE_CLEANUP_SCHEMA,
  manageHomeReleaseCleanup,
  type HomeReleaseCleanupDeps,
  type HomeReleaseCleanupResult,
} from "../../product-host/managed-release-gc";

export type RunHomeCleanupOptions = Readonly<{
  apply?: boolean;
  json?: boolean;
  /** Set only by the nested CLI adapter to reject misleading parent scope. */
  vaultSpecified?: boolean;
}>;

export type HomeCleanupCommandDeps = HomeReleaseCleanupDeps & {
  /** Test-only invocation seam; production always calls the Product Host intent. */
  readonly invokeCleanup?: typeof manageHomeReleaseCleanup | undefined;
};

export async function runHomeCleanup(
  options: RunHomeCleanupOptions = {},
  deps: HomeCleanupCommandDeps = {},
): Promise<number> {
  const mode = options.apply === true ? "apply" as const : "inspect" as const;
  const result = options.vaultSpecified === true
    ? usageResult(mode)
    : await (deps.invokeCleanup ?? manageHomeReleaseCleanup)({ apply: options.apply === true }, deps);
  present(result, options.json === true);
  return result.exitCode;
}

function usageResult(mode: "inspect" | "apply"): HomeReleaseCleanupResult {
  return Object.freeze({
    schema: HOME_RELEASE_CLEANUP_SCHEMA,
    operation: "cleanup",
    mode,
    status: "usage-error",
    exitCode: 64,
    protectedReleaseCount: null,
    candidateCount: null,
    removedCount: null,
    candidates: null,
    reason: "host-wide-command",
    message: "Dome Home cleanup is host-wide and does not accept --vault.",
    nextAction: "none",
  });
}

function present(result: HomeReleaseCleanupResult, json: boolean): void {
  if (json) {
    console.log(formatJson(result));
    return;
  }
  if (result.exitCode !== 0) {
    console.error(`Dome Home cleanup: ${result.message}\n  next: ${humanNext(result.nextAction)}`);
    return;
  }
  if (result.status === "not-installed") {
    console.log("Dome Home cleanup: Home is not installed; nothing to remove.");
    return;
  }
  if (result.status === "clean") {
    console.log("Dome Home cleanup: no unreachable managed release-store entries.");
    return;
  }
  const lines = result.candidates?.map((candidate) =>
    `  - ${candidate.kind}: ${candidate.version ?? "debris"} (${shortId(candidate.artifactId)})`) ?? [];
  if (result.status === "candidates") {
    console.log([
      `Dome Home cleanup: ${result.candidateCount} unreachable managed release-store ` +
        `entr${result.candidateCount === 1 ? "y" : "ies"}.`,
      ...lines,
      "  next: rerun with --apply",
    ].join("\n"));
    return;
  }
  console.log([
    `Dome Home cleanup: removed ${result.removedCount} managed release-store entr${result.removedCount === 1 ? "y" : "ies"}.`,
    ...lines,
  ].join("\n"));
}

function humanNext(nextAction: HomeReleaseCleanupResult["nextAction"]): string {
  if (nextAction === "rerun-with-apply") return "rerun with --apply";
  if (nextAction === "rerun-inspect") return "rerun without --apply";
  if (nextAction === "inspect-home-store") return "inspect Dome Home installation and release-store health";
  return nextAction;
}

function shortId(artifactId: string): string {
  return artifactId.slice(0, 12);
}
