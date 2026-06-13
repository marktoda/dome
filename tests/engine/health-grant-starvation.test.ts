// General grant-starvation probe (`capability.grant-starved`).
//
// Grant-scoped snapshot misses are silent: manifest capability ∩ vault grant
// returning nothing produces no diagnostic, so a starving processor just
// never acts (the owner's calendar weave was silently ungranted for weeks).
// The probe derives a representative concrete path from every
// manifest-declared `read` / `patch.auto` pattern of every loaded processor
// and reports — at info severity, narrowed grants can be deliberate — the
// patterns whose representative the effective grant does not cover. Hand-
// curated `doctor.grantEntries` rows keep precedence: the general probe
// skips entries a hand row already watches. Per-processor replacement
// grants are respected via `resolveGrants` (capability-policy resolves a
// replacement grant INSTEAD of the bundle grant).

import { describe, expect, test } from "bun:test";

import { capabilityGrantStarvationFindings } from "../../src/engine/host/health";
import type { Capability } from "../../src/core/processor";
import type { ManifestGrantEntryRequirement } from "../../src/extensions/manifest-schema";
import type { ProcessorRegistry } from "../../src/processors/registry";

function read(...paths: string[]): Capability {
  return { kind: "read", paths } as Capability;
}
function patchAuto(...paths: string[]): Capability {
  return { kind: "patch.auto", paths } as Capability;
}
function graphWrite(...namespaces: string[]): Capability {
  return { kind: "graph.write", namespaces } as Capability;
}

function stubRegistry(
  declared: Readonly<Record<string, ReadonlyArray<Capability>>>,
): ProcessorRegistry {
  const processors = Object.entries(declared).map(([id, capabilities]) => ({
    id,
    capabilities,
  }));
  return {
    get: (id: string) => processors.find((p) => p.id === id),
    all: () => processors,
  } as unknown as ProcessorRegistry;
}

function findingsFor(opts: {
  readonly declared: Readonly<Record<string, ReadonlyArray<Capability>>>;
  readonly grants: Readonly<Record<string, ReadonlyArray<Capability>>>;
  readonly requirements?: ReadonlyArray<ManifestGrantEntryRequirement>;
}) {
  return capabilityGrantStarvationFindings({
    registry: stubRegistry(opts.declared),
    resolveGrants: (processorId) => opts.grants[processorId] ?? [],
    requirements: opts.requirements ?? [],
    extensionIdFor: (processorId) =>
      processorId.split(".").slice(0, 2).join("."),
  });
}

describe("capabilityGrantStarvationFindings", () => {
  test("the calendar-weave shape: declared read pattern the grant misses → one info finding", () => {
    // The exact silent failure from the ledger: dome.agent.brief declares
    // sources/calendar/*.md but the user-owned vault grant predates it.
    const findings = findingsFor({
      declared: {
        "dome.agent.brief": [
          read("wiki/**/*.md", "sources/calendar/*.md"),
          patchAuto("wiki/dailies/*.md"),
        ],
      },
      grants: {
        "dome.agent.brief": [
          read("wiki/**/*.md"),
          patchAuto("wiki/dailies/*.md"),
        ],
      },
    });
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.code).toBe("capability.grant-starved");
    expect(finding.severity).toBe("info");
    expect(finding.subject).toBe("config");
    expect(finding.message).toContain("dome.agent.brief");
    expect(finding.message).toContain("sources/calendar/*.md");
    expect(finding.recovery).toContain("extensions.dome.agent");
    if (finding.code === "capability.grant-starved") {
      expect(finding.capability.starved).toEqual([
        { kind: "read", pattern: "sources/calendar/*.md" },
      ]);
    }
  });

  test("fully granted (even via broader globs) → quiet", () => {
    expect(
      findingsFor({
        declared: {
          "dome.markdown.lint": [
            read("**/*.md", "core.md", ".dome/page-types.yaml"),
            patchAuto("**/*.md"),
          ],
        },
        grants: {
          "dome.markdown.lint": [
            // Broader/equal grants cover every declared pattern's
            // representative path — the probe shares the broker's matcher.
            read("**"),
            patchAuto("**/*.md"),
          ],
        },
      }),
    ).toEqual([]);
  });

  test("a wholly missing kind is the kind-level probe's job — quiet here", () => {
    expect(
      findingsFor({
        declared: {
          "dome.daily.create": [read("wiki/**/*.md"), patchAuto("notes/*.md")],
        },
        grants: {
          // read granted; patch.auto kind absent entirely.
          "dome.daily.create": [read("wiki/**/*.md")],
        },
      }),
    ).toEqual([]);
  });

  test("hand-curated doctor.grantEntries rows keep precedence — the general probe skips covered entries", () => {
    const requirements: ReadonlyArray<ManifestGrantEntryRequirement> = [
      {
        processorId: "dome.agent.brief",
        entries: [{ kind: "read", target: "core.md" }],
        why: "agents cannot load the owner's core-memory page",
        recovery: "Add core.md to the read grant.",
      },
    ];
    const findings = findingsFor({
      declared: {
        "dome.agent.brief": [
          read("core.md", "sources/slack/*.md"),
          patchAuto("wiki/dailies/*.md"),
        ],
      },
      grants: {
        "dome.agent.brief": [read("wiki/**/*.md"), patchAuto("wiki/dailies/*.md")],
      },
      requirements,
    });
    // core.md is the hand row's job (curated messaging); the general probe
    // reports only the uncovered slack pattern.
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    if (finding.code === "capability.grant-starved") {
      expect(finding.capability.starved).toEqual([
        { kind: "read", pattern: "sources/slack/*.md" },
      ]);
    }
  });

  test("per-processor replacement grants are judged as the effective grant", () => {
    // resolveGrants returns the REPLACEMENT grant for the promotion answer
    // handler (capability-policy machinery): the processor declares core.md
    // read+patch.auto and its replacement grant carries exactly that — no
    // finding, even though the bundle-level grant would miss it.
    expect(
      findingsFor({
        declared: {
          "dome.agent.preference-promotion-answer": [
            read("core.md", "preferences/signals.md"),
            patchAuto("core.md", "preferences/signals.md"),
          ],
        },
        grants: {
          "dome.agent.preference-promotion-answer": [
            read("core.md", "preferences/signals.md"),
            patchAuto("core.md", "preferences/signals.md"),
          ],
        },
      }),
    ).toEqual([]);
  });

  test("a grant that deliberately narrows WITHIN a declared pattern is quiet (partial coverage ≠ starvation)", () => {
    // The work-vault warden shape: the manifest declares wiki/**/*.md and
    // the owner scoped the grant to the four category subtrees. The
    // processor acts on the granted subset — it is narrowed, not starving.
    expect(
      findingsFor({
        declared: {
          "dome.warden.integrity": [read("wiki/**/*.md")],
        },
        grants: {
          "dome.warden.integrity": [
            read(
              "wiki/entities/**/*.md",
              "wiki/concepts/**/*.md",
              "wiki/sources/**/*.md",
              "wiki/syntheses/**/*.md",
            ),
          ],
        },
      }),
    ).toEqual([]);
  });

  test("a granted pattern OUTSIDE the declared pattern does not count as narrowing", () => {
    // dome.claims narrowed to wiki/** while the manifest also declares
    // notes/*.md: the notes pattern has zero intersection with the grant —
    // total miss, reported (deliberate drops are why this is info severity).
    const findings = findingsFor({
      declared: {
        "dome.claims.stamp": [
          read("wiki/**/*.md", "notes/*.md"),
          patchAuto("wiki/**/*.md", "notes/*.md"),
        ],
      },
      grants: {
        "dome.claims.stamp": [read("wiki/**/*.md"), patchAuto("wiki/**/*.md")],
      },
    });
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    if (finding.code === "capability.grant-starved") {
      expect(finding.capability.starved).toEqual([
        { kind: "read", pattern: "notes/*.md" },
        { kind: "patch.auto", pattern: "notes/*.md" },
      ]);
    }
  });

  test("non-path kinds (graph.write etc.) are out of scope", () => {
    expect(
      findingsFor({
        declared: {
          "dome.graph.extract": [read("**/*.md"), graphWrite("dome.graph.*")],
        },
        grants: {
          // graph.write granted under a different namespace — the entry
          // probe / kind probe own that; this probe only reads paths.
          "dome.graph.extract": [read("**/*.md"), graphWrite("other.*")],
        },
      }),
    ).toEqual([]);
  });

  test("brace and multi-glob patterns derive a matchable representative", () => {
    const findings = findingsFor({
      declared: {
        "dome.markdown.assets": [
          read("**/*.{png,jpg,jpeg,gif,webp,svg,avif}", "raw/**"),
        ],
      },
      grants: {
        "dome.markdown.assets": [read("wiki/**/*.md")],
      },
    });
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    if (finding.code === "capability.grant-starved") {
      expect(finding.capability.starved.map((entry) => entry.pattern)).toEqual([
        "**/*.{png,jpg,jpeg,gif,webp,svg,avif}",
        "raw/**",
      ]);
    }
  });

  test("one finding per processor, kinds and patterns aggregated in order", () => {
    const findings = findingsFor({
      declared: {
        "dome.agent.brief": [
          read("sources/calendar/*.md", "sources/slack/*.md"),
          patchAuto("preferences/signals.md"),
        ],
        "dome.daily.create": [read("wiki/**/*.md"), patchAuto("notes/*.md")],
      },
      grants: {
        "dome.agent.brief": [read("wiki/**/*.md"), patchAuto("wiki/**/*.md")],
        "dome.daily.create": [read("wiki/**/*.md"), patchAuto("notes/*.md")],
      },
    });
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    if (finding.code === "capability.grant-starved") {
      expect(finding.capability.processorId).toBe("dome.agent.brief");
      expect(finding.capability.starved).toEqual([
        { kind: "read", pattern: "sources/calendar/*.md" },
        { kind: "read", pattern: "sources/slack/*.md" },
        { kind: "patch.auto", pattern: "preferences/signals.md" },
      ]);
    }
  });
});
