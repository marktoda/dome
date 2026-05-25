// Tier classification for shipped features. See docs/wiki/specs/sdk-surface.md §"Tiered feature model".

import { WorkflowName } from "./workflow-name";

export const WorkflowTier = {
  ShippedDefault: "shipped-default",
  OptIn: "opt-in",
} as const;

export type WorkflowTier = typeof WorkflowTier[keyof typeof WorkflowTier];

// Tier mapping is the canonical source for "is this workflow active by default?"
export const WORKFLOW_TIERS: Readonly<Record<WorkflowName, WorkflowTier>> = {
  [WorkflowName.Ingest]: WorkflowTier.ShippedDefault,
  [WorkflowName.Query]: WorkflowTier.ShippedDefault,
  [WorkflowName.Lint]: WorkflowTier.ShippedDefault,
  [WorkflowName.Migrate]: WorkflowTier.ShippedDefault,
  [WorkflowName.ExportContext]: WorkflowTier.ShippedDefault,
  [WorkflowName.Research]: WorkflowTier.OptIn,
  [WorkflowName.VoiceIngest]: WorkflowTier.OptIn,
  [WorkflowName.SensitivityClassify]: WorkflowTier.OptIn,
  [WorkflowName.ClipIntegrate]: WorkflowTier.OptIn,
};
