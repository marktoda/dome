// Canonical workflow names. See docs/wiki/specs/prompts-and-workflows.md §"Shipped workflows by tier".
//
// Tuple-with-as-const + typeof[number] shape matches src/tools/registry.ts
// TOOL_NAMES. One pattern across the SDK — a future contributor reading both
// files in one sitting sees one rule, not two.

export const WORKFLOW_NAMES = [
  "ingest",
  "query",
  "lint",
  "migrate",
  "export-context",
  "research",
  "voice-ingest",
  "clip-integrate",
] as const;

export type WorkflowName = typeof WORKFLOW_NAMES[number];

export function isWorkflowName(s: string): s is WorkflowName {
  return (WORKFLOW_NAMES as readonly string[]).includes(s);
}
