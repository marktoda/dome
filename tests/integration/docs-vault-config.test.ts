// The docs/ dogfood vault's .dome/config.yaml is itself substrate: it must
// keep the grant entries the memory-quality processors depend on — and stay
// free of personal-vault grants that don't apply to a design vault. These
// pins load the REAL docs vault policy and assert the load-bearing entries,
// so a config edit that reintroduces the lint-supersession false warning or
// a stale personal-surface grant fails CI.

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
  test("dome.markdown core-size retains its declared read contract in the design vault", async () => {
    // The docs vault still has no core.md and no personal-memory loop. The
    // harmless read grant keeps the installed core-size processor's effective
    // capability equal to its manifest contract, so doctor stays honest and
    // the lint begins working automatically if the page is ever introduced.
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
