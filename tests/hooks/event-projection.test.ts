import { describe, test, expect } from "bun:test";
import { projectEffectToEvents } from "../../src/event-projection";
import type { Effect } from "../../src/types";

describe("projectEffectToEvents", () => {
  test("wrote-document under wiki/<type>/ -> document.written.wiki.<type>", () => {
    const eff: Effect = { kind: "wrote-document", path: "wiki/entities/danny.md", diff: "x" };
    const events = projectEffectToEvents(eff);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("document.written.wiki.entity");
    expect(events[0]!.path).toBe("wiki/entities/danny.md");
  });

  test("wrote-document under inbox/<bucket>/ -> document.written.inbox.<bucket>", () => {
    const eff: Effect = { kind: "wrote-document", path: "inbox/raw/abc.md", diff: "x" };
    const events = projectEffectToEvents(eff);
    expect(events[0]!.kind).toBe("document.written.inbox.raw");
  });

  test("wrote-document under raw/ -> document.written.raw", () => {
    const eff: Effect = { kind: "wrote-document", path: "raw/abc.md", diff: "x" };
    const events = projectEffectToEvents(eff);
    expect(events[0]!.kind).toBe("document.written.raw");
  });

  test("wrote-document for index.md -> document.written.index (does NOT match wiki.*)", () => {
    const eff: Effect = { kind: "wrote-document", path: "index.md", diff: "x" };
    const events = projectEffectToEvents(eff);
    expect(events[0]!.kind).toBe("document.written.index");
  });

  test("appended-log -> log.appended", () => {
    const eff: Effect = { kind: "appended-log", entry: { ts: "2026-05-25T00:00:00Z", verb: "ingest", subject: "x" } };
    const events = projectEffectToEvents(eff);
    expect(events[0]!.kind).toBe("log.appended");
  });

  test("moved-document -> document.moved", () => {
    const eff: Effect = { kind: "moved-document", from: "wiki/entities/a.md", to: "wiki/entities/b.md" };
    const events = projectEffectToEvents(eff);
    expect(events[0]!.kind).toBe("document.moved");
  });
});
