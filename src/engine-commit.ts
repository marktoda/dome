import type { EngineVault } from "./engine/core/vault-shape";
import { commit } from "./git";
import type { RunContext } from "./run-context";

export type EngineCommitInput = {
  readonly verb: string;
  readonly subject: string;
  readonly body?: string;
  readonly touchedPaths: ReadonlyArray<string>;
  /**
   * The four-trailer context per ENGINE_COMMITS_CARRY_DOME_TRAILERS. The
   * single chokepoint for engine-commit provenance. `commitEngineChange`
   * throws when this is absent; there is no path to producing a trailer-less
   * engine commit through this function. See docs/wiki/specs/adoption.md
   * §"Engine commit trailers".
   */
  readonly runContext: RunContext;
  readonly author?: { readonly name: string; readonly email: string };
};

/**
 * Atomic engine git commit. Stages every touched path and creates a single
 * commit whose subject is `<verb>: <subject>` and whose body carries the four
 * Dome-* trailers (Dome-Run / Dome-Extension / Dome-Base / Dome-Source-Head)
 * per ENGINE_COMMITS_CARRY_DOME_TRAILERS.
 *
 * Returns the commit SHA, or "" when the vault has disabled
 * `git.auto_commit_workflows`. The caller is responsible for having routed all
 * engine effects to the candidate/working tree before this call.
 */
export async function commitEngineChange(
  vault: EngineVault,
  input: EngineCommitInput,
): Promise<string> {
  if (!vault.config.git.auto_commit_workflows) {
    return "";
  }

  if (input.runContext === undefined || input.runContext === null) {
    throw new Error(
      "commitEngineChange requires a runContext per ENGINE_COMMITS_CARRY_DOME_TRAILERS. " +
        "Construct one via `makeRunContext({ extensionId, base, sourceHead })` from `@marktoda/dome`.",
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
 * The four Dome-* trailer keys composeCommitMessage writes, in order.
 * Surfaces that need to recognize (e.g. strip) the trailer lines build
 * their matching from this list so it cannot drift from the writer.
 */
export const DOME_TRAILER_KEYS = Object.freeze([
  "Dome-Run",
  "Dome-Extension",
  "Dome-Base",
  "Dome-Source-Head",
] as const);

/**
 * Compose `<verb>: <subject>\n\n<body?>\n\n<trailers>`. The trailers sit
 * after a blank separator from the body per `git interpret-trailers`
 * convention; `git interpret-trailers --parse <msg>` round-trips the four
 * lines. Exported for tests and tools that need to render the same trailer
 * shape without creating a commit.
 */
export function composeCommitMessage(input: EngineCommitInput): string {
  const subject = `${input.verb}: ${input.subject}`;
  const values: Record<(typeof DOME_TRAILER_KEYS)[number], string> = {
    "Dome-Run": input.runContext.runId,
    "Dome-Extension": input.runContext.extensionId,
    "Dome-Base": input.runContext.base,
    "Dome-Source-Head": input.runContext.sourceHead,
  };
  const trailers = DOME_TRAILER_KEYS.map((key) => `${key}: ${values[key]}`).join("\n");

  if (input.body !== undefined && input.body.length > 0) {
    return `${subject}\n\n${input.body}\n\n${trailers}`;
  }
  return `${subject}\n\n${trailers}`;
}
