/**
 * Eval assertion factories for brief-shape and trajectory-ordering checks.
 *
 * All assertions are pure (no I/O). Each factory returns an `Assertion<BriefOutput>`:
 * a function that returns `null` on pass or a specific reason string on failure.
 */

import type { Assertion } from "./types";
import type { ToolCallTrace } from "./provider";

// ---------------------------------------------------------------------------
// BriefOutput
// ---------------------------------------------------------------------------

export type BriefOutput = {
  readonly brief: string;
  readonly trajectory: ReadonlyArray<ToolCallTrace>;
};

// ---------------------------------------------------------------------------
// briefShapeValid
// ---------------------------------------------------------------------------

/**
 * Returns an `Assertion<BriefOutput>` that passes only when ALL of the
 * following hold for `output.brief`:
 *
 * 1. Has a YAML front-matter block (`---` … `---`) with a line `type: daily`.
 * 2. Contains the `## Open Loops` heading.
 * 3. Contains at least one `dome.agent.brief:` marker.
 * 4. Total length ≤ `maxChars` (default 20 000).
 *
 * On failure it returns a specific reason string naming the first failing check.
 */
export function briefShapeValid(opts?: { maxChars?: number }): Assertion<BriefOutput> {
  const maxChars = opts?.maxChars ?? 20_000;

  return (output: BriefOutput): string | null => {
    const { brief } = output;

    // Check 1: YAML front-matter declaring `type: daily`
    if (!hasDailyFrontMatter(brief)) {
      return "brief is missing YAML front-matter with `type: daily`";
    }

    // Check 2: ## Open Loops heading
    if (!brief.includes("## Open Loops")) {
      return "brief is missing the `## Open Loops` heading";
    }

    // Check 3: dome.agent.brief: marker
    if (!brief.includes("dome.agent.brief:")) {
      return "brief is missing a `dome.agent.brief:` marker block";
    }

    // Check 4: length budget
    if (brief.length > maxChars) {
      return `brief length ${brief.length} exceeds maxChars limit of ${maxChars}`;
    }

    return null;
  };
}

/**
 * Returns true if `text` starts with a `---`-delimited front-matter block
 * that contains a line matching `type: daily`.
 */
function hasDailyFrontMatter(text: string): boolean {
  // Front-matter must start at the very beginning of the document
  if (!text.startsWith("---")) {
    return false;
  }

  // Find the closing `---` delimiter (first one after the opening)
  const afterOpen = text.indexOf("\n") + 1;
  const closeIdx = text.indexOf("\n---", afterOpen);
  if (closeIdx === -1) {
    return false;
  }

  const frontMatter = text.slice(afterOpen, closeIdx);

  // Check that front-matter contains a `type: daily` line
  return frontMatter.split("\n").some((line) => /^type:\s*daily\s*$/.test(line));
}

// ---------------------------------------------------------------------------
// trajectoryReadsBeforeWrites
// ---------------------------------------------------------------------------

/**
 * Returns an `Assertion<BriefOutput>` that passes when no write-tool call
 * appears at a step before the FIRST read-tool call.
 *
 * - Passes if there are no write-tool calls in the trajectory.
 * - Passes if a read-tool call precedes (or is concurrent with) all write-tool calls.
 * - Fails (with a specific reason) if a write-tool call occurs at a step
 *   strictly less than the step of the first read-tool call.
 *
 * Tool names are passed as parameters (agent-agnostic).
 */
export function trajectoryReadsBeforeWrites(opts: {
  readNames: readonly string[];
  writeNames: readonly string[];
}): Assertion<BriefOutput> {
  const readSet = new Set(opts.readNames);
  const writeSet = new Set(opts.writeNames);

  return (output: BriefOutput): string | null => {
    const { trajectory } = output;

    // Find the step number of the first read-tool call
    let firstReadStep: number | null = null;
    for (const trace of trajectory) {
      for (const call of trace.toolCalls) {
        if (readSet.has(call.name)) {
          if (firstReadStep === null || trace.step < firstReadStep) {
            firstReadStep = trace.step;
          }
          break;
        }
      }
    }

    // Check each write-tool call against the first read step
    for (const trace of trajectory) {
      for (const call of trace.toolCalls) {
        if (writeSet.has(call.name)) {
          if (firstReadStep === null || trace.step < firstReadStep) {
            return (
              `write tool \`${call.name}\` at step ${trace.step} appears before ` +
              (firstReadStep === null
                ? "any read-tool call"
                : `first read at step ${firstReadStep}`)
            );
          }
        }
      }
    }

    return null;
  };
}
