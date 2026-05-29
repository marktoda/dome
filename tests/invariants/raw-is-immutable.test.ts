import { describe, expect, test } from "bun:test";

import { patchEffect } from "../../src/core/effect";
import type { Capability } from "../../src/core/processor";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { enforceCapability } from "../../src/engine/capability-broker";
import { HarnessImpl } from "../harness";

const read: Capability = { kind: "read", paths: ["**"] };
const patchAuto: Capability = { kind: "patch.auto", paths: ["**"] };
const patchPropose: Capability = { kind: "patch.propose", paths: ["**"] };
const ref = sourceRef({ commit: commitOid("abc"), path: "wiki/evidence.md" });

describe("RAW_IS_IMMUTABLE", () => {
  test("broker denies auto and propose PatchEffects targeting raw paths", () => {
    const auto = enforceCapability(
      patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: "raw/example.md", content: "x\n" }],
        reason: "test",
        sourceRefs: [ref],
      }),
      [read, patchAuto],
      [read, patchAuto],
    );
    expect(auto.kind).toBe("deny");
    if (auto.kind !== "deny") return;
    expect(auto.diagnostic.code).toBe("capability-deny-patch");
    expect(auto.diagnostic.message).toContain("raw/ is immutable");
    expect(auto.deniedCapability).toEqual({
      capability: "patch.auto",
      resource: "raw/example.md",
    });

    const propose = enforceCapability(
      patchEffect({
        mode: "propose",
        changes: [{ kind: "write", path: "raw/example.md", content: "x\n" }],
        reason: "test",
        sourceRefs: [ref],
      }),
      [read, patchPropose],
      [read, patchPropose],
    );
    expect(propose.kind).toBe("deny");
    if (propose.kind !== "deny") return;
    expect(propose.diagnostic.code).toBe("capability-deny-patch");
    expect(propose.diagnostic.message).toContain("raw/ is immutable");
    expect(propose.deniedCapability).toEqual({
      capability: "patch.propose",
      resource: "raw/example.md",
    });
  });

  test("committed raw modifications block adoption and preserve adopted ref", async () => {
    const h = await HarnessImpl.create({
      bundles: ["dome.markdown"],
      initialFiles: {
        "raw/example.md": rawBody("original"),
      },
    });
    try {
      const boot = await h.tick();
      expect(boot.adopted).toBe(true);
      const adoptedBefore = await h.refs.adopted();
      if (adoptedBefore === null) throw new Error("expected adopted ref");

      await h.userCommit({
        message: "mutate raw evidence",
        files: {
          "raw/example.md": rawBody("changed"),
        },
      });

      const blocked = await h.tick();
      expect(blocked.adopted).toBe(false);
      expect(blocked.diagnosticCount).toBeGreaterThan(0);
      await h.expectRef("refs/dome/adopted/main").toEqual(adoptedBefore);
      await h
        .expectProjection()
        .diagnostics({ code: "raw.immutable", severity: "block" })
        .toHaveCount(1);
      await h
        .expectProjection()
        .diagnostics({ code: "raw.immutable", severity: "block" })
        .toContainMessage("raw/example.md");
    } finally {
      await h.cleanup();
    }
  });

  test("committed raw creation is adoptable", async () => {
    const h = await HarnessImpl.create({
      bundles: ["dome.markdown"],
    });
    try {
      const boot = await h.tick();
      expect(boot.adopted).toBe(true);

      await h.userCommit({
        message: "add raw evidence",
        files: {
          "raw/example.md": rawBody("new"),
        },
      });

      const adopted = await h.tick();
      expect(adopted.adopted).toBe(true);
      await h.expectRef("refs/dome/adopted/main").toEqualHead();
      await h
        .expectProjection()
        .diagnostics({ code: "raw.immutable" })
        .toHaveCount(0);
    } finally {
      await h.cleanup();
    }
  });
});

function rawBody(body: string): string {
  return [
    "---",
    "type: voice-capture",
    "id: example",
    "---",
    "",
    body,
    "",
  ].join("\n");
}
