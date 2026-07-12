import { describe, expect, test } from "bun:test";
import type { Today, Recents, StreamEvent } from "../src/api/types";
import { AGENT_STREAM_SCHEMA } from "../../contracts/agent-stream";

describe("api types", () => {
  test("shapes accept representative server payloads", () => {
    const today: Today = {
      schema: "dome.daily.today/v1", date: "2026-06-17",
      openTasks: [{ text: "x", path: "wiki/dailies/2026-06-17.md", line: 3, dueDate: null }],
      followups: [], questions: [], brief: null, calendar: null, hero: null,
      counts: { openTasks: 1, followups: 0, questions: 0 },
    };
    const recents: Recents = { schema: "dome.recents/v1", count: 1, entries: [{ path: "wiki/x.md", title: "X", lastChangedAt: "2026-06-17T00:00:00Z", changedBy: "human", subject: "edit" }] };
    const evt: StreamEvent = { schema: AGENT_STREAM_SCHEMA, type: "done", citations: [{ path: "wiki/x.md" }], stopReason: "final" };
    expect(today.openTasks[0]!.text).toBe("x");
    expect(recents.entries[0]!.changedBy).toBe("human");
    expect(evt.type).toBe("done");
  });
});
