// Tier classification for shipped features. See docs/wiki/specs/sdk-surface.md §"Tiered feature model".

import type { WorkflowName } from "./workflow-name";

export const WorkflowTier = {
  ShippedDefault: "shipped-default",
  OptIn: "opt-in",
} as const;

export type WorkflowTier = typeof WorkflowTier[keyof typeof WorkflowTier];

// Tier mapping is the canonical source for "is this workflow active by default?"
export const WORKFLOW_TIERS: Readonly<Record<WorkflowName, WorkflowTier>> = {
  ingest: WorkflowTier.ShippedDefault,
  query: WorkflowTier.ShippedDefault,
  lint: WorkflowTier.ShippedDefault,
  migrate: WorkflowTier.ShippedDefault,
  "export-context": WorkflowTier.ShippedDefault,
  research: WorkflowTier.OptIn,
  "voice-ingest": WorkflowTier.OptIn,
  "clip-integrate": WorkflowTier.OptIn,
};
