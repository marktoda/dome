import { describe, expect, test } from "bun:test";

import {
  agentEscalationEffects,
  agentTruncatedEffect,
  finishAgentRun,
} from "../../../assets/extensions/dome.agent/lib/agent-run-effects";
import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";
import { commitOid, sourceRef } from "../../../src/core/source-ref";

const refs = [sourceRef({ commit: commitOid("a".repeat(40)), path: "log.md" })];

function stateWith(opts: {
  writes?: ReadonlyArray<readonly [string, string]>;
  deletes?: ReadonlyArray<string>;
  questions?: ReadonlyArray<string>;
}): AgentRunState {
  const state: AgentRunState = { edits: new Map(), questions: [], integrityFlags: [] };
  for (const [path, content] of opts.writes ?? []) {
    state.edits.set(path, { kind: "write", path, content });
  }
  for (const path of opts.deletes ?? []) {
    state.edits.set(path, { kind: "delete", path });
  }
  for (const q of opts.questions ?? []) {
    state.questions.push({ question: q, idempotencyKey: `k:${q}` });
  }
  return state;
}

describe("finishAgentRun", () => {
  test("maps accumulated edits to one auto PatchEffect plus escalation diagnostics", () => {
    const state = stateWith({
      writes: [["wiki/a.md", "A"]],
      deletes: ["wiki/b.md"],
      questions: ["keep both?"],
    });
    const effects = finishAgentRun({
      state,
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: test run",
      truncatedMessage: "unused",
    });
    const patches = effects.filter((e) => e.kind === "patch");
    expect(patches).toHaveLength(1);
    const patch = patches[0]!;
    expect(patch.kind === "patch" && patch.mode).toBe("auto");
    expect(patch.kind === "patch" && patch.reason).toBe("dome.agent: test run");
    const plainChanges =
      patch.kind === "patch"
        ? patch.changes.map((c) =>
            c.kind === "write"
              ? { kind: c.kind, path: String(c.path), content: c.content }
              : { kind: c.kind, path: String(c.path) },
          )
        : [];
    expect(plainChanges).toEqual([
      { kind: "write", path: "wiki/a.md", content: "A" },
      { kind: "delete", path: "wiki/b.md" },
    ]);
    const escalations = effects.filter(
      (e) => e.kind === "diagnostic" && e.code === "dome.agent.owner-input-needed",
    );
    expect(escalations).toHaveLength(1);
  });

  test("a final model text rides the patch reason as the run narrative", () => {
    const effects = finishAgentRun({
      state: stateWith({ writes: [["wiki/a.md", "A"]] }),
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: test run",
      truncatedMessage: "unused",
      finalText:
        "Integrated the standup notes into wiki/entities/acme.md\nand archived the source.",
    });
    const patch = effects.find((e) => e.kind === "patch");
    expect(patch?.kind === "patch" && patch.reason).toBe(
      "dome.agent: test run: Integrated the standup notes into wiki/entities/acme.md and archived the source.",
    );
  });

  test("the final-text narrative is flattened and capped at 200 chars", () => {
    const effects = finishAgentRun({
      state: stateWith({ writes: [["wiki/a.md", "A"]] }),
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: test run",
      truncatedMessage: "unused",
      finalText: `  ${"word ".repeat(100)}  `,
    });
    const patch = effects.find((e) => e.kind === "patch");
    if (patch?.kind !== "patch") throw new Error("expected a patch");
    expect(patch.reason).toBe(
      `dome.agent: test run: ${"word ".repeat(100).trim().slice(0, 200)}`,
    );
    expect(patch.reason).not.toContain("\n");
  });

  test("absent or blank final text leaves the static patch reason alone", () => {
    for (const finalText of [undefined, null, "", "   \n\t "]) {
      const effects = finishAgentRun({
        state: stateWith({ writes: [["wiki/a.md", "A"]] }),
        stopReason: "final",
        sourceRefs: refs,
        patchReason: "dome.agent: test run",
        truncatedMessage: "unused",
        finalText,
      });
      const patch = effects.find((e) => e.kind === "patch");
      expect(patch?.kind === "patch" && patch.reason).toBe(
        "dome.agent: test run",
      );
    }
  });

  test("emits no PatchEffect when the run accumulated no edits", () => {
    const effects = finishAgentRun({
      state: stateWith({ questions: ["anything to do?"] }),
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: test run",
      truncatedMessage: "unused",
    });
    expect(effects.filter((e) => e.kind === "patch")).toHaveLength(0);
    expect(
      effects.filter(
        (e) => e.kind === "diagnostic" && e.code === "dome.agent.owner-input-needed",
      ),
    ).toHaveLength(1);
  });

  test("noOp option surfaces a zero-edit final run as an info diagnostic carrying the final text", () => {
    const effects = finishAgentRun({
      state: stateWith({}),
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: test run",
      truncatedMessage: "unused",
      noOp: {
        code: "dome.agent.test-no-op",
        message: (excerpt) => `nothing landed. Model said: ${excerpt}`,
        finalText: "No drift since the last run, nothing to consolidate.",
      },
    });
    const diags = effects.filter((e) => e.kind === "diagnostic");
    expect(diags).toHaveLength(1);
    const diag = diags[0];
    expect(diag?.kind === "diagnostic" && diag.severity).toBe("info");
    expect(diag?.kind === "diagnostic" && diag.code).toBe("dome.agent.test-no-op");
    expect(diag?.kind === "diagnostic" && diag.message).toContain(
      "No drift since the last run",
    );
  });

  test("noOp is silent when edits landed, when questions were asked, or on budget stops", () => {
    const noOp = {
      code: "dome.agent.test-no-op",
      message: (excerpt: string) => `no-op: ${excerpt}`,
      finalText: "text",
    };
    const withEdits = finishAgentRun({
      state: stateWith({ writes: [["wiki/a.md", "x"]] }),
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "r",
      truncatedMessage: "unused",
      noOp,
    });
    expect(
      withEdits.some((e) => e.kind === "diagnostic" && e.code === noOp.code),
    ).toBe(false);

    const withQuestions = finishAgentRun({
      state: stateWith({ questions: ["q?"] }),
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "r",
      truncatedMessage: "unused",
      noOp,
    });
    expect(
      withQuestions.some((e) => e.kind === "diagnostic" && e.code === noOp.code),
    ).toBe(false);

    const onBudget = finishAgentRun({
      state: stateWith({}),
      stopReason: "budget",
      sourceRefs: refs,
      patchReason: "r",
      truncatedMessage: "hit budget",
      noOp,
    });
    expect(
      onBudget.some((e) => e.kind === "diagnostic" && e.code === noOp.code),
    ).toBe(false);
  });

  test("budget stop appends the dome.agent.truncated diagnostic with the given message", () => {
    const effects = finishAgentRun({
      state: stateWith({ writes: [["wiki/a.md", "A"]] }),
      stopReason: "budget",
      sourceRefs: refs,
      patchReason: "dome.agent: test run",
      truncatedMessage: "ran out of steps",
    });
    const diag = effects.find((e) => e.kind === "diagnostic");
    expect(diag?.kind === "diagnostic" && diag.code).toBe("dome.agent.truncated");
    expect(diag?.kind === "diagnostic" && diag.message).toBe("ran out of steps");
    expect(effects.filter((e) => e.kind === "patch")).toHaveLength(1);
  });

  test("atomic cap overreach rolls back all edits but keeps escalation diagnostics", () => {
    const state = stateWith({
      writes: [
        ["wiki/a.md", "A"],
        ["wiki/b.md", "B"],
        ["wiki/c.md", "C"],
      ],
      questions: ["merge these?"],
    });
    const effects = finishAgentRun({
      state,
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: test run",
      truncatedMessage: "unused",
      cap: {
        maxChangedFiles: 2,
        code: "dome.agent.test-overreach",
        message: (count) => `touched ${count} files (cap 2); rolled back.`,
      },
    });
    expect(effects.filter((e) => e.kind === "patch")).toHaveLength(0);
    const diag = effects.find(
      (e) => e.kind === "diagnostic" && e.code === "dome.agent.test-overreach",
    );
    expect(diag?.kind === "diagnostic" && diag.code).toBe("dome.agent.test-overreach");
    expect(diag?.kind === "diagnostic" && diag.message).toBe(
      "touched 3 files (cap 2); rolled back.",
    );
    expect(
      effects.filter(
        (e) => e.kind === "diagnostic" && e.code === "dome.agent.owner-input-needed",
      ),
    ).toHaveLength(1);
  });

  test("a run exactly at the cap still applies", () => {
    const state = stateWith({
      writes: [
        ["wiki/a.md", "A"],
        ["wiki/b.md", "B"],
      ],
    });
    const effects = finishAgentRun({
      state,
      stopReason: "final",
      sourceRefs: refs,
      patchReason: "dome.agent: test run",
      truncatedMessage: "unused",
      cap: {
        maxChangedFiles: 2,
        code: "dome.agent.test-overreach",
        message: (count) => `touched ${count}`,
      },
    });
    expect(effects.filter((e) => e.kind === "patch")).toHaveLength(1);
    expect(effects.filter((e) => e.kind === "diagnostic")).toHaveLength(0);
  });
});

describe("agentEscalationEffects / agentTruncatedEffect (composable pieces)", () => {
  test("agentEscalationEffects keeps inert askOwner output as a source-backed diagnostic", () => {
    const effects = agentEscalationEffects(
      stateWith({ questions: ["is X canonical?"] }),
      refs,
    );
    expect(effects).toHaveLength(1);
    const diagnostic = effects[0]!;
    expect(diagnostic.kind === "diagnostic" && diagnostic.message).toBe("is X canonical?");
    expect(diagnostic.kind === "diagnostic" && diagnostic.code).toBe(
      "dome.agent.owner-input-needed",
    );
    expect(diagnostic.kind === "diagnostic" && diagnostic.sourceRefs).toEqual(refs);
  });

  test("agentTruncatedEffect is null on a final stop and a warning on budget", () => {
    expect(
      agentTruncatedEffect({ stopReason: "final", message: "m", sourceRefs: refs }),
    ).toBeNull();
    const diag = agentTruncatedEffect({
      stopReason: "budget",
      message: "hit the budget",
      sourceRefs: refs,
    });
    expect(diag?.kind === "diagnostic" && diag.severity).toBe("warning");
    expect(diag?.kind === "diagnostic" && diag.code).toBe("dome.agent.truncated");
  });
});
