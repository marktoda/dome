// All 9 dome doctor flags. See docs/wiki/specs/cli.md §"dome doctor" §"Flags:".

export const DoctorFlag = {
  RebuildIndex: "--rebuild-index",
  ShowReviewQueue: "--show review-queue",
  ShowRawCitations: "--show raw-citations",
  ShowWorkflows: "--show workflows",
  ShowEvents: "--show events",
  ShowRecentHookCycles: "--show recent-hook-cycles",
  RecentActivity: "--recent-activity",
  DrainHooks: "--drain-hooks",
  ResetQuarantinedHooks: "--reset-quarantined-hooks",
} as const;

export type DoctorFlag = typeof DoctorFlag[keyof typeof DoctorFlag];

export const DOCTOR_FLAGS: ReadonlyArray<DoctorFlag> = Object.values(DoctorFlag);
