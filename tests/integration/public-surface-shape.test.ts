// Pin the v1 public API surface — every named runtime export from
// src/index.ts must appear in EXPECTED_EXPORTS below, and vice versa.
//
// Adding or removing a public symbol from src/index.ts requires an
// explicit update to this list. Type-only exports are intentionally not
// pinned here (they erase at runtime and are exercised by the tsc check);
// this test guards the *runtime* import surface that downstream
// consumers actually reach.

import { describe, expect, test } from "bun:test";

import * as PublicApi from "../../src";

const EXPECTED_RUNTIME_EXPORTS = new Set<string>([
  // Result + helpers.
  "ok",
  "err",

  // Effect constructors.
  "patchEffect",
  "diagnosticEffect",
  "factEffect",
  "questionEffect",
  "viewEffect",
  "jobEffect",
  "externalActionEffect",

  // Processor types + helpers.
  "defineProcessor",
  "treeOid",
  "transientProcessorError",

  // Source-ref brand helpers.
  "commitOid",

  // Extension bundle loader.
  "loadBundles",
  "flattenBundleProcessors",
  "parseManifest",
  "ManifestSchema",
  "ProcessorDeclarationSchema",

  // Engine commit-trailer helpers.
  "composeCommitMessage",
  "makeRunContext",
  "ENGINE_EXTENSION_ID",
  "ZERO_SHA",

  // Adopted-ref read surface.
  "getAdoptedRef",
  "getCurrentBranch",
  "adoptedRefName",

]);

const FORBIDDEN_RUNTIME_EXPORTS = new Set<string>([
  "commitWorkflow",
  "openProjectionDb",
  "openOutboxDb",
  "openLedgerDb",
]);

describe("public-surface-shape", () => {
  test("every runtime export from src/index.ts is in EXPECTED_RUNTIME_EXPORTS", () => {
    const actualExports = new Set(
      Object.keys(PublicApi).filter((k) => k !== "default"),
    );

    const unexpected: string[] = [];
    for (const name of actualExports) {
      if (!EXPECTED_RUNTIME_EXPORTS.has(name)) unexpected.push(name);
    }

    expect(
      unexpected,
      `Unexpected new public export(s): ${unexpected.join(", ")}. ` +
        `If this is intentional, add the symbol to EXPECTED_RUNTIME_EXPORTS in this file.`,
    ).toEqual([]);
  });

  test("every name in EXPECTED_RUNTIME_EXPORTS is still exported", () => {
    const actualExports = new Set(Object.keys(PublicApi));
    const missing: string[] = [];
    for (const name of EXPECTED_RUNTIME_EXPORTS) {
      if (!actualExports.has(name)) missing.push(name);
    }

    expect(
      missing,
      `Missing expected public export(s): ${missing.join(", ")}. ` +
        `Either restore the export or remove the name from EXPECTED_RUNTIME_EXPORTS.`,
    ).toEqual([]);
  });

  test("write-capable internals are not exported from the package root", () => {
    const actualExports = new Set(Object.keys(PublicApi));
    const leaked = [...FORBIDDEN_RUNTIME_EXPORTS].filter((name) =>
      actualExports.has(name),
    );

    expect(
      leaked,
      `Forbidden public export(s): ${leaked.join(", ")}. ` +
        `Keep write-capable internals behind implementation paths.`,
    ).toEqual([]);
  });
});
