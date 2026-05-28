// scenarios/lifecycle/throwing-processor-blocks-adoption.scenario.test.ts
//
// A processor that throws unconditionally: the executor synthesizes a
// `processor.threw` DiagnosticEffect with severity `block`, marks the
// ledger row failed with structured error JSON, and the daemon DOES NOT
// crash. Adoption does not advance because adoption-phase execution
// failures are blocking diagnostics.
//
// No shipped processor throws, so this scenario writes a synthetic test
// bundle inline: a single adoption-phase processor whose `run` throws
// `Error("intentional test failure")`. The harness reopens the runtime
// to pick up the new bundle, then commits a markdown file (firing
// `document.changed` / `file.created`), then ticks.
//
// Post-conditions:
//   - The synthetic processor has exactly one failed ledger row with
//     structured `processor.threw` error populated.
//   - Adoption did not advance: `tick.adopted === false`.
//   - A synthesized `processor.threw` diagnostic landed (severity block).
//   - No exception escaped the tick boundary.

import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { scenario } from "../../index";
import type { Harness } from "../../types";

scenario(
  {
    name: "lifecycle: a throwing adoption processor fails its ledger row and blocks adoption",
    tags: [
      { kind: "group", group: "lifecycle" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
    ],
    // No shipped bundles — only the synthetic one we install inline.
    harness: {},
  },
  async (h) => {
    // Step 0: install the synthetic throwing bundle and reopen the
    // runtime so the registry picks it up.
    await installThrowingBundle(h);

    // Step 1: init the adopted ref. This is an empty-diff init
    // (base === head === seed-commit), so compile-range emits no signals
    // and the throwing processor doesn't fire on this tick.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 2: commit a markdown file. This triggers `document.changed`
    // + `file.created`, dispatching the throwing processor.
    await h.userCommit({
      files: { "wiki/trigger.md": "# trigger the throw\n" },
      message: "trigger throwing processor",
    });

    // Step 3: tick. Adoption MUST NOT complete: the executor turns the
    // throw into a block diagnostic + failed ledger row. No exception
    // should escape.
    const result = await h.tick();
    expect(result.adopted).toBe(false);
    expect(result.diagnosticCount).toBeGreaterThan(0);

    // Step 4: the synthetic processor has exactly one ledger row, with
    // status `failed` and `error` populated.
    const row = await h
      .expectLedger({ processorId: "test.throwing.always" })
      .toHaveExactlyOne();
    expect(row.status).toBe("failed");
    expect(row.error).not.toBeNull();
    if (row.error !== null) {
      const parsed = JSON.parse(row.error);
      expect(parsed.code).toBe("processor.threw");
      expect(parsed.message).toContain("intentional test failure");
      expect(parsed.processorId).toBe("test.throwing.always");
    }

    // Step 5: the synthesized `processor.threw` block diagnostic landed.
    // Diagnostics don't require a capability declaration, so the broker
    // admits the diagnostic before adoption refuses to advance. The adopted
    // ref stays unchanged, but projection persistence still records the
    // failed proposal's diagnostic so the user can inspect why adoption
    // blocked.
    await h
      .expectProjection()
      .diagnostics({ code: "processor.threw", severity: "block" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "processor.threw", severity: "block" })
      .toContainMessage("intentional test failure");
  },
);

// ----- synthetic bundle scaffolding ----------------------------------------

/**
 * Write a one-processor test bundle into the harness vault's
 * `.dome/extensions/test.throwing/` and reopen the runtime so the loader
 * picks it up.
 *
 * The bundle is plain TypeScript with a default-export object; Bun's
 * dynamic-import loader compiles it on the fly. Unlike the shipped
 * bundles under `assets/extensions/` (which import types via relative
 * paths into `src/core/`), this synthetic processor has no type imports
 * — the vault tmpdir is not a sibling of the SDK source, so relative
 * imports back to `src/` would not resolve. The loader duck-types
 * against the manifest declaration, so an unannotated literal with
 * `as const` is sufficient.
 */
async function installThrowingBundle(h: Harness): Promise<void> {
  const bundleDir = join(h.vaultPath, ".dome", "extensions", "test.throwing");
  await mkdir(join(bundleDir, "processors"), { recursive: true });

  await writeFile(
    join(bundleDir, "manifest.yaml"),
    `id: test.throwing
version: 0.1.0
processors:
  - id: test.throwing.always
    version: 0.1.0
    phase: adoption
    triggers:
      - kind: signal
        name: document.changed
      - kind: signal
        name: file.created
    capabilities: []
    module: processors/throw.ts
`,
    "utf8",
  );

  // The processor module is written WITHOUT type imports. The shipped
  // bundles under `assets/extensions/` import types from `../../../../src/`
  // because they live as siblings of `src/` in the SDK repo — but the
  // harness's vault is a tmpdir created at runtime, so there's no
  // resolvable relative path back to the SDK source.
  //
  // The loader duck-types: `loadProcessorModule` validates only the
  // `(id, version, phase)` identity triple against the manifest declaration;
  // `triggers`, `capabilities`, and `run` are consumed by the runtime
  // without further type validation at load time. So the synthetic
  // processor's literal object with `as const` annotations is sufficient.
  await writeFile(
    join(bundleDir, "processors", "throw.ts"),
    `// Synthetic test processor for the throwing-processor scenario.
// No type imports — the manifest loader duck-types this module's default
// export against the manifest declaration's (id, version, phase) triple.

const processor = {
  id: "test.throwing.always",
  version: "0.1.0",
  phase: "adoption" as const,
  triggers: [
    { kind: "signal" as const, name: "document.changed" as const },
    { kind: "signal" as const, name: "file.created" as const },
  ],
  capabilities: [] as const,
  run: async (): Promise<readonly never[]> => {
    throw new Error("intentional test failure");
  },
};

export default processor;
`,
    "utf8",
  );

  // Reopen so the new bundle is loaded.
  await h.reopenRuntime();
}
