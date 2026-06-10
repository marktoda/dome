// The docs/ dogfood vault's .dome/config.yaml is itself substrate: it must
// keep the grant entries the memory-quality processors depend on. These pins
// load the REAL docs vault policy and assert the load-bearing entries, so a
// config edit that silently kills a lint (the dead-core-size-lint shape) or
// reintroduces the lint-supersession false warning fails CI.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadCapabilityPolicy } from "../../src/engine/core/capability-policy";
import { pathCapabilityMatches } from "../../src/engine/core/path-capabilities";
import { requireVaultPath } from "../../src/core/vault-path";
import type { Capability } from "../../src/core/processor";

const DOCS_VAULT = join(__dirname, "..", "..", "docs");

async function docsGrants(
  processorId: string,
): Promise<ReadonlyArray<Capability>> {
  const policy = await loadCapabilityPolicy(DOCS_VAULT);
  expect(policy.ok).toBe(true);
  if (!policy.ok) throw new Error(policy.error);
  return policy.value.grantsForProcessor("dome.markdown", processorId);
}

describe("docs vault config (the dogfood vault's own grants)", () => {
  test("dome.markdown bundle read grant covers core.md — the core-size lint must fire", async () => {
    const granted = await docsGrants("dome.markdown.core-size");
    expect(
      pathCapabilityMatches("read", requireVaultPath("core.md"), granted),
    ).toBe(true);
  });

  test("lint-supersession's read override covers root-level forward targets", async () => {
    // Rule 1 resolves superseded_by targets against the processor's READABLE
    // set; the docs vault narrows dome.markdown's bundle read to wiki/**, so
    // without the per-processor override a forward link to a root page
    // (e.g. memory.md) raises a false missing-forward-link warning.
    const granted = await docsGrants("dome.markdown.lint-supersession");
    expect(
      pathCapabilityMatches("read", requireVaultPath("memory.md"), granted),
    ).toBe(true);
    expect(
      pathCapabilityMatches(
        "read",
        requireVaultPath("wiki/specs/preferences.md"),
        granted,
      ),
    ).toBe(true);
  });

  test("validate-wikilinks keeps its full-vault read override (the mirrored shape)", async () => {
    const granted = await docsGrants("dome.markdown.validate-wikilinks");
    expect(
      pathCapabilityMatches("read", requireVaultPath("memory.md"), granted),
    ).toBe(true);
  });
});
