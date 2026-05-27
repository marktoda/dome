// Pins the @dome/sdk core entrypoint's shape: the symbols pruned from
// src/index.ts in Phase B must NOT reappear there.
//
// Companion to bundle-deps.test.ts: that test catches transitive-dep
// regression; this test catches symbol-restore-with-fixed-deps (a
// contributor adds runWorkflow back to src/index.ts but re-routes it
// through a path that doesn't pull `ai` — bundle-deps passes; this
// test fails).

import { describe, test, expect } from "bun:test";
import * as core from "../../src/index";

const PRUNED_SYMBOLS: ReadonlyArray<string> = [
  // workflows entrypoint
  "runWorkflow", "DEFAULT_MODEL", "DEFAULT_MAX_STEPS",
  "WorkflowRegistry", "PromptLoader", "PromptSource",
  "parseWorkflowFrontmatter", "isWorkflowPrompt", "WorkflowFrontmatterSchema",
  "makeFixtureVault",
  "WorkflowName", "WORKFLOW_NAMES", "isWorkflowName",
  "WorkflowTier", "WORKFLOW_TIERS",
  "filterAiTools",
  // mcp entrypoint
  "DomeMcpServer", "renderMcp", "ResourceAdapter", "ResourceUri",
];

const REQUIRED_CORE_SYMBOLS: ReadonlyArray<string> = [
  "openVault", "makeDocument", "INVARIANTS",
  "readDocument", "writeDocument", "appendLog", "searchIndex",
  "wikilinkResolve", "moveDocument", "deleteDocument",
  "HookRegistry", "HookDispatcher", "TOOL_NAMES", "MCP_TOOL_NAMES",
  "MUTATING_TOOL_NAMES", "VaultWatcher", "isDirtyGitState",
  "buildAbstractSurface",
  // Phase 1+3 adoption substrate.
  "sync", "getAdoptionStatus", "getAdoptedRef", "getCurrentBranch",
  "adoptedRefName", "makeRunContext", "ENGINE_EXTENSION_ID", "ZERO_SHA",
];

// Symbols that used to be exported from @dome/sdk core and have been
// pruned post-Phase-1+3. Keeps the structural-fence test as the canonical
// signal that the rename / chokepoint move actually landed at the public
// surface; if a future contributor restores any of these, this test fails.
const RETIRED_CORE_SYMBOLS: ReadonlyArray<string> = [
  // Replaced by `sync` per ADOPTED_REF_IS_SEMANTIC_CURSOR — reconcile
  // remains callable via deep import from `src/reconcile.ts` but is no
  // longer part of the public surface so it can't be invoked without
  // advancing the adopted ref.
  "reconcile", "ReconcileResult", "ReconcileOpts",
];

describe("public surface shape — pruned symbols", () => {
  test("src/index.ts (core entrypoint) does not export the LLM/MCP/workflow symbols", () => {
    const exportedNames = new Set(Object.keys(core));
    const violations = PRUNED_SYMBOLS.filter(s => exportedNames.has(s));
    if (violations.length > 0) {
      throw new Error(
        `These symbols must not be exported from @dome/sdk core; ` +
        `they belong at @dome/sdk/workflows or @dome/sdk/mcp:\n  ${violations.join("\n  ")}`,
      );
    }
    expect(violations).toEqual([]);
  });

  test("src/index.ts (core entrypoint) still exports the kept symbols", () => {
    const exportedNames = new Set(Object.keys(core));
    const missing = REQUIRED_CORE_SYMBOLS.filter(s => !exportedNames.has(s));
    expect(missing).toEqual([]);
  });

  test("src/index.ts (core entrypoint) does not re-export retired symbols", () => {
    const exportedNames = new Set(Object.keys(core));
    const violations = RETIRED_CORE_SYMBOLS.filter(s => exportedNames.has(s));
    expect(violations).toEqual([]);
  });
});
