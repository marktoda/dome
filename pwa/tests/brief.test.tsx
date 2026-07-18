import { afterEach, describe, expect, test, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Brief } from "../src/components/Brief";
import type { Today } from "../src/api/types";

afterEach(cleanup);
const base: Today = { schema: "dome.daily.today/v1", date: "2026-06-17", openTasks: [], followups: [], questions: [], brief: null, calendar: null, hero: null, counts: { openTasks: 0, followups: 0, questions: 0 } };
const noop = () => {};

describe("Brief", () => {
  test("renders open tasks with due dates and a question whose option resolves", () => {
    const onResolve = mock(() => {});
    const today: Today = { ...base,
      openTasks: [{ text: "Draft roadmap", path: "wiki/dailies/d.md", line: 1, dueDate: "2026-06-20" }],
      questions: [{ id: 7, question: "Hourly or daily?", resolveCommand: "dome resolve 7 <value>", options: ["hourly", "daily"] }],
      counts: { openTasks: 1, followups: 0, questions: 1 } };
    render(<Brief today={today} onResolve={onResolve} />);
    expect(screen.getByText(/Draft roadmap/)).toBeDefined();
    expect(screen.getByText(/Jun 20/)).toBeDefined(); // dueDate is formatted "2026-06-20" → "Jun 20"
    fireEvent.click(screen.getByRole("button", { name: "hourly" }));
    expect(onResolve).toHaveBeenCalledWith(7, "hourly");
  });

  test("shows an all-clear state when nothing is open", () => {
    render(<Brief today={base} onResolve={() => {}} />);
    expect(screen.getByText(/you're clear/i)).toBeDefined();
  });

  test("offers one backlog-review entry from the open-task surface", () => {
    const onReviewBacklog = mock(() => {});
    const today: Today = {
      ...base,
      openTasks: [{ text: "Review me", path: "wiki/a.md", line: 3, dueDate: null }],
      counts: { openTasks: 1, followups: 0, questions: 0 },
    };
    render(<Brief today={today} onResolve={noop} onReviewBacklog={onReviewBacklog} />);

    const entry = screen.getByRole("button", { name: "Review backlog" });
    expect(screen.getAllByRole("button", { name: /Review backlog/ })).toHaveLength(1);
    fireEvent.click(entry);
    expect(onReviewBacklog).toHaveBeenCalledTimes(1);
  });

  test("renders and summarizes a followup once even when the facet array repeats it", () => {
    const followup = {
      text: "Follow up with Jane",
      path: "p",
      line: 1,
      dueDate: null,
      followup: true,
    } as const;
    render(<Brief
      today={{
        ...base,
        openTasks: [followup],
        followups: [followup],
        counts: { openTasks: 1, followups: 1, questions: 0 },
      }}
      onResolve={noop}
    />);
    fireEvent.click(screen.getByRole("button", { name: /\+1 more, later/ }));
    expect(screen.getAllByText("Follow up with Jane")).toHaveLength(1);
    expect(screen.getByText(/1 focus/i)).toBeDefined();
    expect(screen.queryByText(/2 open/i)).toBeNull();
  });

  test("buckets tasks by urgency, shows a priority marker, and renders no hero card", () => {
    const today: Today = { ...base, date: "2026-06-17",
      openTasks: [
        { text: "Overdue thing", path: "p", line: 1, dueDate: "2026-06-10", priority: "highest" },
        { text: "Due today thing", path: "p", line: 2, dueDate: "2026-06-17" },
      ],
      counts: { openTasks: 2, followups: 0, questions: 0 },
      // even when the payload carries a hero, the PWA no longer paints one:
      hero: { kind: "task", item: { text: "Overdue thing", path: "p", line: 1, dueDate: "2026-06-10" } } };
    render(<Brief today={today} onResolve={() => {}} />);
    expect(screen.getByText(/overdue · 1/i)).toBeDefined();   // urgency bucket label
    expect(screen.getByText(/today · 1/i)).toBeDefined();
    expect(screen.getByText(/Overdue thing/)).toBeDefined();
    expect(screen.getByText("▲▲")).toBeDefined();             // priority marker (shared glyph)
    expect(screen.getByText("▲▲").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText(/Highest priority/)).toBeDefined();
    expect(screen.queryByText(/THE ONE THING/)).toBeNull();   // hero retired
  });

  test("renders the agenda from calendar events", () => {
    const today: Today = { ...base, date: "2026-06-17",
      calendar: { events: [{ time: "09:00", title: "Standup", meta: "Eng" }], sourceRef: { path: "sources/calendar/x.md" } },
      openTasks: [{ text: "something", path: "p", line: 1, dueDate: null }],
      counts: { openTasks: 1, followups: 0, questions: 0 } };
    render(<Brief today={today} onResolve={() => {}} />);
    expect(screen.getByText("Agenda")).toBeDefined();
    expect(screen.getByText("09:00")).toBeDefined();
    expect(screen.getByText(/Standup/)).toBeDefined();
  });

  test("makes bounded reviews evidence-backed and gives the backlog one exact Mac action", () => {
    const today: Today = {
      ...base,
      reviews: [{
        id: 12,
        reason: "Promote the link repair processor",
        processorId: "dome.health.trust-review",
        paths: [".dome/config.yaml"],
        reviewCommand: "dome proposals",
      }],
      attentionBacklog: 2,
      counts: { openTasks: 0, followups: 0, questions: 0, reviews: 1 },
    };
    render(<Brief today={today} onResolve={noop} />);
    expect(screen.getByText("Needs review")).toBeDefined();
    expect(screen.getByText("Promote the link repair processor")).toBeDefined();
    expect(screen.getByText(/Evidence: \.dome\/config.yaml/)).toBeDefined();
    expect(screen.getByText("dome proposals")).toBeDefined();
    expect(screen.getByText(/2 more items need attention/)).toBeDefined();
    expect(screen.getByText("dome check --decisions")).toBeDefined();
    expect(screen.getByText(/3 review/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: "apply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "reject" })).toBeNull();
  });

  test("does not render all-clear when only bounded owner attention remains", () => {
    const today: Today = {
      ...base,
      attentionBacklog: 2,
      counts: { openTasks: 0, followups: 0, questions: 0, reviews: 0 },
    };
    render(<Brief today={today} onResolve={noop} />);
    expect(screen.queryByText("You're clear.")).toBeNull();
    expect(screen.getByText(/2 review/i)).toBeDefined();
  });

  test("uses the bounded review count even when no review rows were loaded", () => {
    const today: Today = {
      ...base,
      reviews: [],
      counts: { openTasks: 0, followups: 0, questions: 0, reviews: 3 },
    };
    render(<Brief today={today} onResolve={noop} />);
    expect(screen.queryByText("You're clear.")).toBeNull();
    expect(screen.getByText(/3 review/i)).toBeDefined();
  });

  test("folds 30-day backlog debt separately and expands it with live settlement", async () => {
    const onSettle = mock(async () => true);
    const today: Today = {
      ...base,
      date: "2026-07-01",
      openTasks: [
        { text: "Recent backlog", path: "p", line: 1, source: "backlog", dueDate: "2026-06-02" },
        { text: "Old backlog", path: "p", line: 2, source: "backlog", dueDate: "2026-06-01", blockId: "old12345" },
      ],
      counts: { openTasks: 2, followups: 0, questions: 0 },
    };

    render(<Brief today={today} onResolve={noop} onSettle={onSettle} />);
    expect(screen.getByText(/2 focus/i)).toBeDefined();
    expect(screen.getByText("Recent backlog")).toBeDefined();
    expect(screen.queryByText("Old backlog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /1 older backlog item · 30\+ days overdue/ }));
    const checkbox = screen.getByRole("checkbox", { name: "Old backlog" });
    fireEvent.click(checkbox);
    await waitFor(() => expect(onSettle).toHaveBeenCalledWith("old12345"));
  });

  test("uses loaded bucket lengths for reveal math and reports omitted rows separately", () => {
    const today: Today = {
      ...base,
      openTasks: [
        { text: "Due now", path: "p", line: 1, source: "daily", dueDate: "2026-06-17" },
        { text: "Later one", path: "p", line: 2, source: "daily", dueDate: null },
        { text: "Later two", path: "p", line: 3, source: "daily", dueDate: null },
      ],
      counts: { openTasks: 10, followups: 0, questions: 0 },
    };

    render(<Brief today={today} onResolve={noop} />);
    expect(screen.getByText(/10 focus/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /\+2 more, later/ })).toBeDefined();
    expect(screen.getByText("7 additional open items omitted from this view")).toBeDefined();
    expect(screen.queryByText(/\+9 more, later/)).toBeNull();
  });
});

// ----- checkbox settle (Task 9: PWA checkbox settles for real) --------------
//
// Glance-and-settle: a task WITH a blockId gets a live checkbox that fires
// onSettle(blockId) and optimistically strikes through; a task with none
// stays decorative (disabled, never fires). Mirrors the resolve test's
// pattern of asserting the callback dispatch, plus the async optimistic ->
// revert-on-error lifecycle the resolve callback doesn't need (resolving
// removes the question outright; settling must survive a failed request).

describe("Brief — checkbox settle", () => {
  test("a task with a blockId renders a live, enabled checkbox", () => {
    const today: Today = { ...base,
      openTasks: [{ text: "Ship the thing", path: "p", line: 1, dueDate: "2026-06-17", blockId: "t1a2b3c4" }],
      counts: { openTasks: 1, followups: 0, questions: 0 } };
    render(<Brief today={today} onResolve={noop} onSettle={async () => true} />);
    const box = screen.getByRole("checkbox", { name: /ship the thing/i });
    expect(box).toBeDefined();
    expect((box as HTMLInputElement).disabled).toBe(false);
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(box.closest(".task-hit")).not.toBeNull();
  });

  test("a task with no blockId renders no checkbox at all (decorative-only)", () => {
    const today: Today = { ...base,
      openTasks: [{ text: "Not yet anchored", path: "p", line: 1, dueDate: "2026-06-17" }],
      counts: { openTasks: 1, followups: 0, questions: 0 } };
    const onSettle = mock(async () => true);
    render(<Brief today={today} onResolve={noop} onSettle={onSettle} />);
    expect(screen.getByText(/Not yet anchored/)).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(onSettle).not.toHaveBeenCalled();
  });

  test("checking the box fires onSettle(blockId, 'close') and optimistically strikes through", () => {
    const onSettle = mock(() => new Promise<boolean>(() => {})); // never resolves — inspect the optimistic state
    const today: Today = { ...base,
      openTasks: [{ text: "Ship the thing", path: "p", line: 1, dueDate: "2026-06-17", blockId: "t1a2b3c4" }],
      counts: { openTasks: 1, followups: 0, questions: 0 } };
    render(<Brief today={today} onResolve={noop} onSettle={onSettle} />);
    const box = screen.getByRole("checkbox", { name: /ship the thing/i }) as HTMLInputElement;
    fireEvent.click(box);
    expect(onSettle).toHaveBeenCalledWith("t1a2b3c4");
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true); // no double-fire while settling
    expect(box.closest(".row")?.className).toContain("settling"); // strike-through hook
  });

  test("reverts the optimistic strike-through when onSettle resolves false (settle failed)", async () => {
    let resolveSettle: (ok: boolean) => void = () => {};
    const onSettle = mock(() => new Promise<boolean>((resolve) => { resolveSettle = resolve; }));
    const today: Today = { ...base,
      openTasks: [{ text: "Ship the thing", path: "p", line: 1, dueDate: "2026-06-17", blockId: "t1a2b3c4" }],
      counts: { openTasks: 1, followups: 0, questions: 0 } };
    render(<Brief today={today} onResolve={noop} onSettle={onSettle} />);
    const box = screen.getByRole("checkbox", { name: /ship the thing/i }) as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true);

    resolveSettle(false);
    await waitFor(() => expect(box.checked).toBe(false));
    expect(box.disabled).toBe(true);
    expect(box.closest(".row")?.className).not.toContain("settling");
    expect(screen.getByRole("alert").textContent).toContain("Completion was not saved");
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  test("reverts the optimistic strike-through when onSettle rejects", async () => {
    let rejectSettle: (err: unknown) => void = () => {};
    const onSettle = mock(() => new Promise<boolean>((_resolve, reject) => { rejectSettle = reject; }));
    const today: Today = { ...base,
      openTasks: [{ text: "Ship the thing", path: "p", line: 1, dueDate: "2026-06-17", blockId: "t1a2b3c4" }],
      counts: { openTasks: 1, followups: 0, questions: 0 } };
    render(<Brief today={today} onResolve={noop} onSettle={onSettle} />);
    const box = screen.getByRole("checkbox", { name: /ship the thing/i }) as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true);

    rejectSettle(new Error("network down"));
    await waitFor(() => expect(box.checked).toBe(false));
    expect(box.disabled).toBe(true);
    expect(screen.getByRole("alert")).toBeDefined();
  });

  test("confirms success politely and prevents duplicate settlement", async () => {
    let resolveSettle: (ok: boolean) => void = () => {};
    const onSettle = mock(() => new Promise<boolean>((resolve) => { resolveSettle = resolve; }));
    const today: Today = { ...base,
      openTasks: [{ text: "Ship the thing", path: "p", line: 1, dueDate: "2026-06-17", blockId: "t1a2b3c4" }],
      counts: { openTasks: 1, followups: 0, questions: 0 } };
    render(<Brief today={today} onResolve={noop} onSettle={onSettle} />);
    const box = screen.getByRole("checkbox", { name: /ship the thing/i }) as HTMLInputElement;
    fireEvent.click(box);
    fireEvent.click(box);
    expect(onSettle).toHaveBeenCalledTimes(1);
    resolveSettle(true);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Completed “Ship the thing”."));
    expect(screen.getByText("Completed", { exact: true })).toBeDefined();
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
  });

  test("Retry invokes the same settlement once after failure", async () => {
    const outcomes = [false, true];
    const onSettle = mock(async () => outcomes.shift() ?? true);
    const today: Today = { ...base,
      openTasks: [{ text: "Ship the thing", path: "p", line: 1, dueDate: "2026-06-17", blockId: "t1a2b3c4" }],
      counts: { openTasks: 1, followups: 0, questions: 0 } };
    render(<Brief today={today} onResolve={noop} onSettle={onSettle} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /ship the thing/i }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Completed"));
    expect(onSettle).toHaveBeenCalledTimes(2);
    expect(onSettle).toHaveBeenNthCalledWith(1, "t1a2b3c4");
    expect(onSettle).toHaveBeenNthCalledWith(2, "t1a2b3c4");
  });
});
