// scenarios/cli-surface/capture-adopt.scenario.test.ts
//
// Wedge Phase 3 acceptance shape (docs/wedge.md §"Phase 3 — Capture loop"):
// `dome capture "<idea>"` → the capture is committed on the current branch as
// an ordinary human commit → within one serve tick the commit is adopted. The
// scenario proves the capture commit is real drift the compiler host picks
// up — capture itself never touches the engine.

import { expect } from "bun:test";

import { commitOid } from "../../../../src/core/source-ref";
import { scenario } from "../../index";

scenario(
  {
    name: "cli-surface: dome capture lands a raw capture the next tick adopts",
    tags: [{ kind: "group", group: "cli-surface" }],
    harness: {
      // Capture requires an initialized vault: .dome/config.yaml present.
      initialFiles: { ".dome/config.yaml": "extensions: {}\n" },
    },
  },
  async (h) => {
    // Adopt the baseline first so the capture commit is clean drift on top
    // of an initialized adopted ref.
    await h.tick();

    const capture = await h.runCli([
      "capture",
      "call the landlord about the radiator",
      "--json",
    ]);
    expect(capture.exitCode).toBe(0);
    expect(capture.stderr).toBe("");
    const payload = JSON.parse(capture.stdout) as {
      readonly schema: string;
      readonly status: string;
      readonly path: string;
      readonly title: string;
      readonly source: string;
      readonly branch: string;
      readonly commit: string;
      readonly adopted_initialized: boolean;
      readonly compile_pending: boolean;
    };
    expect(payload.schema).toBe("dome.capture/v1");
    expect(payload.status).toBe("captured");
    expect(payload.title).toBe("call the landlord about the radiator");
    expect(payload.source).toBe("cli");
    expect(payload.path).toMatch(
      /^inbox\/raw\/\d{4}-\d{2}-\d{2}-\d{4}-call-the-landlord-about-the-radiator\.md$/,
    );
    // The adopted ref was initialized by the baseline tick; no serve host is
    // running in the harness, so the hint correctly reports compile pending.
    expect(payload.adopted_initialized).toBe(true);
    expect(payload.compile_pending).toBe(true);

    // The capture is an ordinary human commit on the branch: HEAD moved to
    // it, the adopted ref has not caught up yet.
    const before = await h.refs.current();
    expect(before.head).toBe(commitOid(payload.commit));
    expect(before.adopted).not.toBe(before.head);
    await h.expectCommit(payload.commit).toHaveSubjectMatching(/^capture: /);

    // One serve tick adopts the capture — the Phase 3 acceptance boundary.
    const tick = await h.tick();
    expect(tick.adopted).toBe(true);
    const adopted = await h.refs.adopted();
    if (adopted === null) throw new Error("adopted ref missing after tick");
    await h
      .expectFile(payload.path, { atCommit: adopted })
      .toContain("call the landlord about the radiator");
    await h.expectFile(payload.path, { atCommit: adopted }).toContain(
      "source: cli",
    );
  },
);
