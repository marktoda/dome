// engine/host/health/inputs: build the HealthInputs context from an open
// runtime. `dome check` and `dome doctor` both call this; each then sets its
// own extras (probe input, commit-signing, thresholds). This bridge belongs at
// the engine/host layer (runtime ↔ health), not in surface/.
import type { VaultRuntime } from "../vault-runtime";
import type { HealthInputs } from "./types";

/** The HealthInputs derived from an open runtime (callers add their extras). */
export function healthInputsFromRuntime(runtime: VaultRuntime): HealthInputs {
  return {
    vaultPath: runtime.path,
    projection: runtime.projectionDb,
    ledger: runtime.ledgerDb,
    outbox: runtime.outboxDb,
    executionState: runtime.processorRuntime.executionState,
    extensions: runtime.extensions,
    processorVersions: runtime.processorVersions,
    capabilityPolicyHash: runtime.capabilityPolicyHash,
    registry: runtime.registry,
    resolveGrants: runtime.resolveGrants,
    extensionIdFor: runtime.extensionIdFor,
    extensionConfigFor: runtime.extensionConfigFor,
    doctorGrantEntries: runtime.doctorGrantEntries,
    modelProviderConfigured: runtime.modelProvider !== undefined,
    externalHandlerTimeoutConfigured:
      runtime.config.engine.externalHandlerTimeoutMs !== undefined,
  };
}

