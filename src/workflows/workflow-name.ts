// Canonical workflow names. See docs/wiki/specs/prompts-and-workflows.md §"Shipped workflows by tier".

export const WorkflowName = {
  Ingest: "ingest",
  Query: "query",
  Lint: "lint",
  Migrate: "migrate",
  ExportContext: "export-context",
  Research: "research",
  VoiceIngest: "voice-ingest",
  ClipIntegrate: "clip-integrate",
} as const;

export type WorkflowName = typeof WorkflowName[keyof typeof WorkflowName];

export const WORKFLOW_NAMES: ReadonlyArray<WorkflowName> = Object.values(WorkflowName);

export function isWorkflowName(s: string): s is WorkflowName {
  return WORKFLOW_NAMES.includes(s as WorkflowName);
}
