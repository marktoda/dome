import { createHash } from "node:crypto";

import {
  SETUP_CONSENT_SCHEMA,
  type SetupConsent,
  type SetupPlan,
  validateSetupConsent,
  validateSetupPlan,
} from "./contracts";

/**
 * Consent is deliberately the digest of the complete validated plan. The plan
 * already contains the observed HEAD, worktree fingerprint, repository
 * inventory, content scope, and every proposed write digest, so one token
 * binds the user's approval to all mutation-relevant evidence.
 */
export function setupPlanSha256(value: SetupPlan): string {
  const plan = validateSetupPlan(value);
  return createHash("sha256").update(stableJson(plan)).digest("hex");
}

export function createSetupConsent(plan: SetupPlan): SetupConsent {
  return validateSetupConsent({
    schema: SETUP_CONSENT_SCHEMA,
    planSha256: setupPlanSha256(plan),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
