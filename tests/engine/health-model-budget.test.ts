// Model-budget grant/declaration mismatch probe (`model.budget-grant-capped`).
//
// The effective `model.invoke` daily cost cap is min(manifest-declared,
// vault-granted). Raising the vault grant above the manifest declaration is
// silently ineffective — the declaration stays binding and the operator gets
// no signal (this starved the capture loop on 2026-06-10: a grant bump to $10
// could not lift ingest's declared $5). `dome doctor` / `dome check` must
// name the mismatch and the binding side. These tests drive
// `modelBudgetGrantFindings` directly with a stub registry.

import { describe, expect, test } from "bun:test";

import { modelBudgetGrantFindings } from "../../src/engine/host/health";
import type { Capability } from "../../src/core/processor";
import type { ProcessorRegistry } from "../../src/processors/registry";

function modelInvoke(maxDailyCostUsd?: number): Capability {
  return (maxDailyCostUsd === undefined
    ? { kind: "model.invoke" }
    : { kind: "model.invoke", maxDailyCostUsd }) as Capability;
}

function stubRegistry(
  processors: ReadonlyArray<{
    readonly id: string;
    readonly capabilities: ReadonlyArray<Capability>;
  }>,
): ProcessorRegistry {
  return {
    get: (id: string) => processors.find((p) => p.id === id),
    all: () => processors,
  } as unknown as ProcessorRegistry;
}

function findingsFor(opts: {
  readonly declared: number | undefined;
  readonly granted: number | undefined;
  readonly grantHasModelInvoke?: boolean;
}) {
  const registry = stubRegistry([
    { id: "dome.agent.ingest", capabilities: [modelInvoke(opts.declared)] },
  ]);
  const grants: ReadonlyArray<Capability> =
    opts.grantHasModelInvoke === false ? [] : [modelInvoke(opts.granted)];
  return modelBudgetGrantFindings({
    registry,
    resolveGrants: () => grants,
  });
}

describe("modelBudgetGrantFindings", () => {
  test("flags a grant raised above the manifest declaration", () => {
    const findings = findingsFor({ declared: 5, granted: 15 });
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.code).toBe("model.budget-grant-capped");
    expect(finding.severity).toBe("warning");
    expect(finding.subject).toBe("config");
    expect(finding.id).toBe("dome.agent.ingest");
    expect(finding.message).toContain("dome.agent.ingest");
    expect(finding.message).toContain("5");
    expect(finding.message).toContain("15");
    if (finding.code === "model.budget-grant-capped") {
      expect(finding.budget.declaredMaxDailyCostUsd).toBe(5);
      expect(finding.budget.grantedMaxDailyCostUsd).toBe(15);
    }
  });

  test("silent when grant equals the declaration", () => {
    expect(findingsFor({ declared: 5, granted: 5 })).toHaveLength(0);
  });

  test("silent when grant is below the declaration (grant is binding by choice)", () => {
    expect(findingsFor({ declared: 10, granted: 5 })).toHaveLength(0);
  });

  test("silent when the manifest declares no cap (grant is effective)", () => {
    expect(findingsFor({ declared: undefined, granted: 15 })).toHaveLength(0);
  });

  test("silent when the grant carries no cap", () => {
    expect(findingsFor({ declared: 5, granted: undefined })).toHaveLength(0);
  });

  test("silent when model.invoke is not granted at all (kind-level probe's job)", () => {
    expect(
      findingsFor({ declared: 5, granted: 15, grantHasModelInvoke: false }),
    ).toHaveLength(0);
  });
});
