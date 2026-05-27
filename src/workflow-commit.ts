import { commit } from "./git";
import type { RunContext } from "./run-context";
import type { Vault } from "./vault";

export interface WorkflowCommitInput {
  verb: string;
  subject: string;
  body?: string;
  touchedPaths: ReadonlyArray<string>;
  /**
   * The four-trailer context per ENGINE_COMMITS_CARRY_DOME_TRAILERS. The
   * single chokepoint for engine-commit provenance. `commitWorkflow` throws
   * when this is absent — there is no path to producing a trailer-less
   * engine commit through this function. See docs/wiki/specs/adoption.md
   * §"Engine commit trailers".
   */
  runContext: RunContext;
  author?: { name: string; email: string };
}

/**
 * Per-workflow atomic git commit. Stages every touched path and creates a
 * single commit whose subject is `<verb>: <subject>` and whose body carries
 * the four Dome-* trailers (Dome-Run / Dome-Extension / Dome-Base /
 * Dome-Source-Head) per ENGINE_COMMITS_CARRY_DOME_TRAILERS.
 *
 * Returns the commit SHA, or "" when the vault has disabled
 * `git.auto_commit_workflows`. The caller is responsible for having driven all
 * Tool effects to the working tree prior to this call.
 *
 * Refuses (throws) when `runContext` is missing — the structural fence
 * against trailer-less engine commits. The single legitimate caller of
 * `commitWorkflow` today is `runWorkflow`; future callers (closure-pass
 * commits in `src/adoption.ts`'s close step, Phase 4+'s patch-mediated
 * extension effects) construct their RunContext explicitly.
 */
export async function commitWorkflow(vault: Vault, input: WorkflowCommitInput): Promise<string> {
  if (!vault.config.git.auto_commit_workflows) {
    return ""; // commit skipped; caller may still log
  }

  // Structural fence per ENGINE_COMMITS_CARRY_DOME_TRAILERS — refuse rather
  // than produce a trailer-less engine commit. The throw is intentional: a
  // missing runContext is a programming error in the caller, not a recoverable
  // runtime condition.
  if (input.runContext === undefined || input.runContext === null) {
    throw new Error(
      "commitWorkflow requires a runContext per ENGINE_COMMITS_CARRY_DOME_TRAILERS. " +
        "Construct one via `makeRunContext({ extensionId, base, sourceHead })` from `@dome/sdk`.",
    );
  }

  const message = composeCommitMessage(input);
  return commit({
    path: vault.path,
    message,
    files: input.touchedPaths,
    ...(input.author !== undefined ? { author: input.author } : {}),
  });
}

/**
 * Compose `<verb>: <subject>\n\n<body?>\n\n<trailers>`. The trailers sit
 * after a blank separator from the body per `git interpret-trailers`
 * convention; `git interpret-trailers --parse <msg>` round-trips the four
 * lines. Exported for tests; production callers reach this through
 * `commitWorkflow`.
 */
export function composeCommitMessage(input: WorkflowCommitInput): string {
  const subject = `${input.verb}: ${input.subject}`;
  const trailers = [
    `Dome-Run: ${input.runContext.runId}`,
    `Dome-Extension: ${input.runContext.extensionId}`,
    `Dome-Base: ${input.runContext.base}`,
    `Dome-Source-Head: ${input.runContext.sourceHead}`,
  ].join("\n");

  if (input.body !== undefined && input.body.length > 0) {
    return `${subject}\n\n${input.body}\n\n${trailers}`;
  }
  return `${subject}\n\n${trailers}`;
}
