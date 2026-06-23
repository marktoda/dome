import { afterEach, describe, expect, test, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Brief } from "../src/components/Brief";
import type { Today } from "../src/api/types";

afterEach(cleanup);
const base: Today = { schema: "dome.daily.today/v1", date: "2026-06-17", openTasks: [], followups: [], questions: [], brief: null, calendar: null, hero: null, counts: { openTasks: 0, followups: 0, questions: 0 } };

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
});
