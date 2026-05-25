import { describe, test, expect } from "bun:test";
import { HookRegistry } from "../../src/hook-registry";
import type { HookHandler } from "../../src/hook-context";

const noop: HookHandler = async () => {};

describe("HookRegistry", () => {
  test("registers and lists hooks in registration order", () => {
    const reg = new HookRegistry();
    reg.register({ id: "a", pattern: "document.written.wiki.*", handler: noop, source: "sdk", async: true, idempotent: true });
    reg.register({ id: "b", pattern: "document.written.wiki.entity", handler: noop, source: "vault-local", async: true, idempotent: true });
    const all = reg.list();
    expect(all.length).toBe(2);
    expect(all[0]!.id).toBe("a");
    expect(all[1]!.id).toBe("b");
  });

  test("matchesEvent: exact match wins over wildcard", () => {
    const reg = new HookRegistry();
    reg.register({ id: "wild", pattern: "document.written.wiki.*", handler: noop, source: "sdk", async: true, idempotent: true });
    reg.register({ id: "exact", pattern: "document.written.wiki.entity", handler: noop, source: "sdk", async: true, idempotent: true });
    const matches = reg.matchesEvent("document.written.wiki.entity");
    expect(matches.length).toBe(2);
    // Both fire when the event matches; "most-specific-first" applies to dispatch order, tested elsewhere.
    expect(matches.find(m => m.id === "exact")).toBeDefined();
    expect(matches.find(m => m.id === "wild")).toBeDefined();
  });

  test("source layering: vault-local overrides SDK by same id", () => {
    const reg = new HookRegistry();
    const sdkHandler: HookHandler = async () => {};
    const localHandler: HookHandler = async () => {};
    reg.register({ id: "auto-update-index", pattern: "document.written.wiki.*", handler: sdkHandler, source: "sdk", async: true, idempotent: true });
    reg.register({ id: "auto-update-index", pattern: "document.written.wiki.*", handler: localHandler, source: "vault-local", async: true, idempotent: true });
    const all = reg.list();
    expect(all.length).toBe(1);
    expect(all[0]!.handler).toBe(localHandler);
    expect(all[0]!.source).toBe("vault-local");
  });

  test("quarantine: failing N times disables the handler", () => {
    const reg = new HookRegistry();
    reg.register({ id: "x", pattern: "*", handler: noop, source: "sdk", async: true, idempotent: true });
    reg.recordFailure("x");
    reg.recordFailure("x");
    expect(reg.isQuarantined("x")).toBe(false);
    reg.recordFailure("x");
    expect(reg.isQuarantined("x")).toBe(true);
    reg.resetQuarantines();
    expect(reg.isQuarantined("x")).toBe(false);
  });
});
