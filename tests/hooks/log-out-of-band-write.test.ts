import { describe, test, expect } from "bun:test";
import { logOutOfBandWrite } from "../../src/hooks/log-out-of-band-write";
import type { HookContext } from "../../src/hook-context";

describe("logOutOfBandWrite", () => {
  test("calls appendLog with out-of-band-tagged subject for vault.out-of-band-edit events", async () => {
    const calls: Array<{ verb: string; subject: string }> = [];
    const ctx = {
      tools: {
        appendLog: async (input: { verb: string; subject: string }) => {
          calls.push(input);
          return { result: { ok: true, value: {} as never }, effects: [] };
        },
      },
    } as unknown as HookContext;
    await logOutOfBandWrite(
      { kind: "vault.out-of-band-edit", path: "wiki/entities/danny.md", fsKind: "modified" } as never,
      ctx,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.verb).toBe("update");
    expect(calls[0]!.subject).toContain("wiki/entities/danny.md");
    expect(calls[0]!.subject.toLowerCase()).toContain("out-of-band");
  });

  test("skips dispatcher-owned paths (log.md, index.md) to avoid cycles", async () => {
    const calls: Array<{ verb: string; subject: string }> = [];
    const ctx = {
      tools: {
        appendLog: async (input: { verb: string; subject: string }) => {
          calls.push(input);
          return { result: { ok: true, value: {} as never }, effects: [] };
        },
      },
    } as unknown as HookContext;
    await logOutOfBandWrite(
      { kind: "vault.out-of-band-edit", path: "log.md", fsKind: "modified" } as never,
      ctx,
    );
    await logOutOfBandWrite(
      { kind: "vault.out-of-band-edit", path: "index.md", fsKind: "modified" } as never,
      ctx,
    );
    expect(calls.length).toBe(0);
  });

  test("ignores events of other kinds", async () => {
    const calls: Array<{ verb: string; subject: string }> = [];
    const ctx = {
      tools: {
        appendLog: async (input: { verb: string; subject: string }) => {
          calls.push(input);
          return { result: { ok: true, value: {} as never }, effects: [] };
        },
      },
    } as unknown as HookContext;
    await logOutOfBandWrite(
      { kind: "document.written.wiki.entity", path: "wiki/entities/x.md" } as never,
      ctx,
    );
    expect(calls.length).toBe(0);
  });
});
