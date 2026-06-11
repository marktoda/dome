// surface/health-inputs: the runtime → collectHealthReport field mapping.
//
// `dome check` and `dome doctor` both build the same fifteen-field options
// object from an open VaultRuntime; this helper owns the mapping once. Each
// caller spreads the result and adds its own extras (probe input, orphan
// threshold).

import type { VaultRuntime } from "../engine/host/vault-runtime";

/** The shared `collectHealthReport` inputs derived from an open runtime. */
export function runtimeHealthReportInputs(runtime: VaultRuntime) {
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
    extensionConfigFor: runtime.extensionConfigFor,
    doctorGrantEntries: runtime.doctorGrantEntries,
    modelProviderConfigured: runtime.modelProvider !== undefined,
    externalHandlerTimeoutConfigured:
      runtime.config.engine.externalHandlerTimeoutMs !== undefined,
  } as const;
}
