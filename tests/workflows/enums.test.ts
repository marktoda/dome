import { describe, test, expect } from "bun:test";
import { WORKFLOW_NAMES, isWorkflowName } from "../../src/workflows/workflow-name";
import { WorkflowTier, WORKFLOW_TIERS } from "../../src/workflows/workflow-tier";

describe("workflow enums", () => {
  test("9 canonical workflow names", () => {
    expect(WORKFLOW_NAMES.length).toBe(9);
  });
  test("isWorkflowName narrows correctly", () => {
    expect(isWorkflowName("ingest")).toBe(true);
    expect(isWorkflowName("bogus")).toBe(false);
  });
  test("5 shipped-default + 4 opt-in", () => {
    const tiers = Object.values(WORKFLOW_TIERS);
    const shipped = tiers.filter((t) => t === WorkflowTier.ShippedDefault).length;
    const optin = tiers.filter((t) => t === WorkflowTier.OptIn).length;
    expect(shipped).toBe(5);
    expect(optin).toBe(4);
  });
});
