// Per-item tool set for the nightly sweep agent. Each agent run is scoped to
// exactly ONE destination page — the hard write boundary is enforced here at
// tool time so the worst a fully-compromised model can do is bad text on that
// one page. No delete tool, no signals append, no ledger access: those are
// all out of scope for the integration step (the processor writes the ledger
// deterministically; preference learning is deferred to a later task).

import type { AgentTool } from "./agent-loop";
import {
  listPagesTool,
  readPageTool,
  searchVaultTool,
  type VaultReader,
} from "./vault-tools";
import { objectSchema } from "./vault-tools";
import { globMatch } from "../../../../src/engine/glob-cache";

/**
 * Bundle-local mirror of the `dome.agent.sweep` manifest `patch.auto` grant.
 * Pinned to manifest.yaml by the grant-aware-tools manifest-sync test —
 * edit both together. The per-item editDestination scope is narrower still
 * (exactly one path per run); this constant exists for the grant-pinning test
 * in Task 4.
 */
export const SWEEP_WRITABLE_PATHS: ReadonlyArray<string> = Object.freeze([
  "wiki/entities/**/*.md",
  "wiki/concepts/**/*.md",
  "sweep-ledger.md",
]);

/**
 * Build the per-item tool set for one sweep agent run.
 *
 * @param opts.reader       - VaultReader (snapshot + overlay seam).
 * @param opts.destination  - The ONE writable path for this run (e.g.
 *                            "wiki/entities/alice-henshaw.md"). Any write
 *                            attempt to a different path returns a denial
 *                            string and records no edit. Must match one of
 *                            SWEEP_WRITABLE_PATHS — throws at build time if
 *                            not (programming-error guard).
 * @param opts.onQuestion   - Called by recordUncertainIntegration when the
 *                            model cannot confidently integrate. The processor
 *                            uses this to build a rich QuestionEffect with
 *                            the proposed section as metadata.
 */
export function makeSweepTools(opts: {
  readonly reader: VaultReader;
  readonly destination: string;
  readonly onQuestion: (q: {
    readonly summary: string;
    readonly proposedSection: string;
  }) => void;
}): ReadonlyArray<AgentTool> {
  const { reader, destination, onQuestion } = opts;

  // Item 8: programming-error guard — destination must be in the grant at
  // build time. The processor should never construct tools for an out-of-grant
  // path; catching this at construction time surfaces the bug immediately.
  const destinationInGrant = SWEEP_WRITABLE_PATHS.some((pattern) =>
    globMatch(pattern, destination),
  );
  if (!destinationInGrant) {
    throw new Error(
      `makeSweepTools: destination "${destination}" matches none of SWEEP_WRITABLE_PATHS ` +
        `(${SWEEP_WRITABLE_PATHS.join(", ")}). ` +
        `This is a programming error — the processor must only target grant-listed paths.`,
    );
  }

  const editDestinationTool: AgentTool = {
    schema: {
      name: "editDestination",
      description:
        "Write the full updated content of the destination page. " +
        "Read it first (readPage), integrate the material, then write it back. " +
        "Only the configured destination path is accepted; any other path is rejected.",
      inputSchema: objectSchema(
        {
          path: { type: "string" },
          content: { type: "string" },
        },
        ["path", "content"],
      ),
    },
    execute: async (input, state) => {
      const { path, content } = input as { path: string; content: string };

      // Item 2: input validation — non-empty strings required, no state mutation on failure
      if (typeof path !== "string" || path.length === 0) {
        return "error: path must be a non-empty string";
      }
      if (typeof content !== "string" || content.length === 0) {
        return "error: content must be a non-empty string";
      }

      // Item 1: strict path equality — no glob matching. The destination is a
      // known singleton; vault filenames can contain glob metachars (e.g.
      // "acme-[v2].md") which would admit writes to unintended siblings if we
      // used glob matching here. Strict equality is the only safe check.
      if (path !== destination) {
        return `error: ${path} is not this run's destination (${destination}); editDestination writes only that one page.`;
      }

      state.edits.set(path, { kind: "write", path, content });
      return `wrote ${path}`;
    },
  };

  const recordUncertainIntegrationTool: AgentTool = {
    schema: {
      name: "recordUncertainIntegration",
      description:
        "Call this when you are unsure how to integrate the material — " +
        "ambiguous identity, contradictory claims you cannot resolve, or when " +
        "the correct destination section is unclear. Provide a summary of the " +
        "uncertainty and a proposed section text. Make NO edit; the owner will decide.",
      inputSchema: objectSchema(
        {
          summary: { type: "string" },
          proposedSection: { type: "string" },
        },
        ["summary", "proposedSection"],
      ),
    },
    execute: async (input, _state) => {
      const { summary, proposedSection } = input as {
        summary: string;
        proposedSection: string;
      };

      // Item 2: input validation — non-empty strings required, callback NOT invoked on failure
      if (typeof summary !== "string" || summary.length === 0) {
        return "error: summary must be a non-empty string";
      }
      if (typeof proposedSection !== "string" || proposedSection.length === 0) {
        return "error: proposedSection must be a non-empty string";
      }

      onQuestion({ summary, proposedSection });
      // No edit recorded — state is not touched.
      return "recorded — the owner will decide";
    },
  };

  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    editDestinationTool,
    recordUncertainIntegrationTool,
  ];
}
