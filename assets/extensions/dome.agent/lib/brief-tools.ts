// Tool bindings for the morning-brief agent — composed from the shared
// vault-tools. The ingest read set plus the daily-note write; no deletePage
// (the brief never removes pages) and no archiveSource (nothing to consume).
import type { AgentTool } from "./agent-loop";
import {
  appendToPageTool,
  askOwnerTool,
  currentContent,
  listPagesTool,
  objectSchema,
  readPageTool,
  searchVaultTool,
  signalsAppendOnlyGuard,
  writePageTool,
  type VaultReader,
} from "./vault-tools";
import { spliceCapturedTask } from "./captured-task-seam";

/**
 * Bundle-local mirror of the `dome.agent.brief` manifest `patch.auto`
 * grant. Pinned to manifest.yaml by the grant-aware-tools manifest-sync
 * test — edit both together. (The brief processor's splice guard is
 * stricter still: only today's daily note lands.)
 */
export const BRIEF_WRITABLE_PATHS: ReadonlyArray<string> = Object.freeze([
  "wiki/dailies/*.md",
  "notes/*.md",
  // Validated signal-line appends only — enforced at tool time by
  // signalsAppendOnlyGuard (and again by the brief processor's post-run
  // splice guard, which drops anything that slips through).
  "preferences/signals.md",
]);

export function makeBriefTools(opts: {
  readonly reader: VaultReader;
  readonly capturedTasks?: { readonly path: string };
}): ReadonlyArray<AgentTool> {
  const { reader, capturedTasks } = opts;
  // preferences/signals.md is writable but append-only: the guard rejects
  // rewrites/deletions at tool time so the model cannot touch the owner's
  // rejection tombstones — self-correctable mid-loop, instead of relying
  // solely on the brief processor's post-run splice guard (silent drop).
  const guard = signalsAppendOnlyGuard(reader);
  const tools: AgentTool[] = [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(BRIEF_WRITABLE_PATHS, guard),
    appendToPageTool(reader, BRIEF_WRITABLE_PATHS, guard),
    askOwnerTool("dome.agent.brief:"),
  ];
  if (capturedTasks !== undefined) {
    tools.push(addTaskTool({ reader, capturedTasks }));
  }
  return tools;
}

/**
 * The `addTask` tool — surfaces ONE actionable finding from today's brief
 * as an open task line in the daily's captured block. Each call reads the
 * overlay-aware current content (so multiple calls in a run accumulate),
 * validates and stamps the source URL via spliceCapturedTask, then writes
 * back to state.edits.
 */
function addTaskTool(opts: {
  readonly reader: VaultReader;
  readonly capturedTasks: { readonly path: string };
}): AgentTool {
  const { reader, capturedTasks } = opts;
  return {
    schema: {
      name: "addTask",
      description:
        "Surface ONE actionable finding as an open `- [ ] #task <short label>` line in today's daily, with its source URL (e.g. a Slack permalink) as sourceUrl. Use ONLY for genuinely actionable items; everything else is a plain `-` summary bullet.",
      inputSchema: objectSchema(
        {
          task: { type: "string" },
          sourceUrl: { type: "string" },
        },
        ["task"],
      ),
    },
    execute: async (input, state) => {
      const { task, sourceUrl } = input as { task: string; sourceUrl?: string };
      const content = (await currentContent(capturedTasks.path, state, reader)) ?? "";
      const r = spliceCapturedTask({
        content,
        task,
        ...(sourceUrl !== undefined && sourceUrl !== "" ? { sourceUrl } : {}),
      });
      if (!r.ok) return `error: ${r.error}`;
      state.edits.set(capturedTasks.path, {
        kind: "write",
        path: capturedTasks.path,
        content: r.content,
      });
      return `added captured task to ${capturedTasks.path}`;
    },
  };
}
