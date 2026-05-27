// Shared types for `dome doctor` structural checks.
//
// Each check exports a single `(vault) => Promise<CheckResult>` so adding a
// new check is one file + one entry in the CHECKS array in
// `src/cli/commands/doctor.ts`. See `docs/wiki/specs/cli.md §"dome doctor"`.

import type { Vault } from "../../../vault";

export interface CheckResult {
  violations: string[];
  info: string[];
}

export type DoctorCheck = (vault: Vault) => Promise<CheckResult>;
