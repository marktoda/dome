import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DomeClient } from "../src/api/client";
import type { TaskBacklog, TaskBacklogReviewResult } from "../src/api/types";
import { BacklogReview } from "../src/components/BacklogReview";

afterEach(cleanup);

const REVISION = "a".repeat(40);

function member(input: {
  id: string;
  path: string;
  line: number;
  blockId?: string;
  reviewable?: boolean;
  dueDate?: string | null;
}) {
  return {
    id: input.id,
    path: input.path,
    line: input.line,
    source: "backlog" as const,
    followup: false,
    dueDate: input.dueDate ?? null,
    priority: null,
    lastChangedAt: "2026-07-12T10:00:00.000Z",
    ...(input.blockId === undefined ? {} : { blockId: input.blockId }),
    reviewable: input.reviewable ?? true,
    sourceContext: {
      path: input.path,
      title: input.path.includes("a.md") ? "Alpha" : "Beta",
      line: input.line,
      lastChangedAt: "2026-07-12T10:00:00.000Z",
    },
    sourceRefs: [{
      path: input.path,
      commit: REVISION,
      stableId: `dome.daily.open-loop:${input.blockId ?? input.id}`,
      range: { startLine: input.line, endLine: input.line },
    }],
  };
}

type Member = ReturnType<typeof member>;

function unit(input: {
  id?: string;
  text?: string;
  members?: Member[];
  timing?: "overdue" | "dated" | "undated";
  duplicate?: boolean;
  reviewable?: boolean;
} = {}) {
  const members = input.members ?? [member({ id: "m1", path: "wiki/a.md", line: 3, blockId: "task-a" })];
  return {
    id: input.id ?? "unit-1",
    text: input.text ?? "Ship the launch",
    normalizedText: (input.text ?? "Ship the launch").toLowerCase(),
    classification: {
      timing: input.timing ?? "undated",
      exactDuplicateCandidate: input.duplicate ?? members.length > 1,
    },
    reviewable: input.reviewable ?? members.every((item) => item.reviewable),
    members,
  };
}

function page(input: {
  items?: ReturnType<typeof unit>[];
  total?: number;
  commitments?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
} = {}): Extract<TaskBacklog, { status: "ok" }> {
  const items = input.items ?? [unit()];
  return {
    schema: "dome.daily.task-backlog.list/v1",
    status: "ok",
    date: "2026-07-16",
    revision: REVISION,
    snapshot: "b".repeat(64),
    groups: {
      overdue: items.filter((item) => item.classification.timing === "overdue").length,
      dated: items.filter((item) => item.classification.timing === "dated").length,
      exactDuplicateCandidates: items.filter((item) => item.classification.exactDuplicateCandidate).length,
      undated: items.filter((item) => item.classification.timing === "undated").length,
    },
    page: {
      limit: 25,
      returned: items.length,
      total: input.total ?? items.length,
      commitments: input.commitments ?? items.reduce((count, item) => count + item.members.length, 0),
      hasMore: input.hasMore ?? false,
      nextCursor: input.nextCursor ?? null,
    },
    items,
  };
}

const settled = (overrides: Partial<Extract<TaskBacklogReviewResult, { status: "settled" }>> = {}): Extract<TaskBacklogReviewResult, { status: "settled" }> => ({
  schema: "dome.task-backlog.review/v1",
  status: "settled",
  revision: REVISION,
  reviewed: { keep: 0, close: 1, defer: 0 },
  commit: "c".repeat(40),
  adoptionStatus: "pending",
  ...overrides,
});

function fakeClient(input: {
  taskBacklog?: (request: { limit?: number; cursor?: string }) => Promise<TaskBacklog>;
  review?: (request: unknown) => Promise<TaskBacklogReviewResult>;
  source?: DomeClient["source"];
} = {}): DomeClient {
  return {
    taskBacklog: input.taskBacklog ?? (async () => page()),
    reviewTaskBacklog: input.review ?? (async () => settled()),
    source: input.source ?? (async (citation) => ({
      schema: "dome.source-document/v1",
      status: "ok",
      path: citation.path,
      commit: citation.commit!,
      content: "# Exact adopted source\n",
    })),
  } as unknown as DomeClient;
}

describe("BacklogReview", () => {
  test("loads 25-unit pages, labels exact-text groups, and pages by cursor", async () => {
    const first = page({
      items: [unit({
        duplicate: true,
        members: [
          member({ id: "m1", path: "wiki/a.md", line: 3, blockId: "task-a", dueDate: "2026-07-01" }),
          member({ id: "m2", path: "wiki/a.md", line: 8, blockId: "task-b" }),
        ],
        timing: "overdue",
      })],
      total: 26,
      commitments: 27,
      hasMore: true,
      nextCursor: "next-cursor",
    });
    const second = page({ items: [unit({ id: "unit-2", text: "Second page" })], total: 26, commitments: 27 });
    const calls: Array<{ limit?: number; cursor?: string }> = [];
    const taskBacklog = mock(async (request: { limit?: number; cursor?: string }) => {
      calls.push(request);
      return request.cursor === undefined ? first : second;
    });

    render(<BacklogReview client={fakeClient({ taskBacklog })} interactive onReviewed={() => {}} />);

    await waitFor(() => expect(screen.getByText("Ship the launch")).toBeDefined());
    expect(screen.getByText("26 review units")).toBeDefined();
    expect(screen.getByText("27 commitments")).toBeDefined();
    expect(screen.getByText(/Exact duplicate candidate · 2 commitments/)).toBeDefined();
    expect(screen.getByText(/Due 2026-07-01/)).toBeDefined();
    expect(screen.getByText(/No due date/)).toBeDefined();
    expect(taskBacklog).toHaveBeenNthCalledWith(1, { limit: 25 });

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Second page")).toBeDefined());
    expect(taskBacklog).toHaveBeenNthCalledWith(2, { limit: 25, cursor: "next-cursor" });
    expect(screen.getByText(/Page 2/)).toBeDefined();
  });

  test("opens each member's matching exact adopted source and restores focus", async () => {
    const seen: unknown[] = [];
    const source = mock(async (citation: Parameters<DomeClient["source"]>[0]) => {
      seen.push(citation);
      return {
        schema: "dome.source-document/v1" as const,
        status: "ok" as const,
        path: citation.path,
        commit: citation.commit!,
        content: "# Exact adopted source\n",
      };
    });
    render(<BacklogReview client={fakeClient({ source })} interactive onReviewed={() => {}} />);
    const open = await screen.findByRole("button", { name: "Alpha · wiki/a.md:3" });

    fireEvent.click(open);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(seen).toEqual([{ path: "wiki/a.md", commit: REVISION }]);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  test("requires an explicit valid defer date, supports confirmation cancel, and posts one exact batch", async () => {
    const review = mock(async (_request: unknown) => settled({
      reviewed: { keep: 0, close: 0, defer: 1 },
    }));
    render(<BacklogReview client={fakeClient({ review })} interactive onReviewed={() => {}} />);
    await screen.findByText("Ship the launch");

    fireEvent.click(screen.getByRole("radio", { name: "Defer" }));
    const reviewSelected = screen.getByRole("button", { name: "Review selected" }) as HTMLButtonElement;
    expect(reviewSelected.disabled).toBe(true);
    const date = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: "2026-08-01" } });
    expect(reviewSelected.disabled).toBe(false);

    fireEvent.click(reviewSelected);
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(screen.getByText("0 leave open · 1 defer · 0 close")).toBeDefined();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Apply 1 selected" }));
    fireEvent.click(cancel);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // useModalFocus restores the trigger in its documented cleanup microtask.
    // Flush that exact boundary instead of polling, which can starve the queued
    // restoration under Bun's happy-dom runner.
    await Promise.resolve();
    expect(document.activeElement).toBe(reviewSelected);
    expect(review).toHaveBeenCalledTimes(0);

    fireEvent.click(screen.getByRole("button", { name: "Review selected" }));
    const apply = screen.getByRole("button", { name: "Apply 1 selected" });
    fireEvent.click(apply);
    fireEvent.click(apply);
    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    expect(review).toHaveBeenCalledWith({
      schema: "dome.task-backlog.review/v1",
      revision: REVISION,
      decisions: [{
        blockId: "task-a",
        disposition: "defer",
        deferUntil: "2026-08-01",
        sourceRef: {
          path: "wiki/a.md",
          commit: REVISION,
          stableId: "dome.daily.open-loop:task-a",
          range: { startLine: 3, endLine: 3 },
        },
      }],
    });
    await waitFor(() => expect(screen.getByText(/awaiting adoption/i)).toBeDefined());
  });

  test("keeps are explicit and a keep-only receipt says nothing was committed", async () => {
    const review = mock(async (_request: unknown) => settled({
      reviewed: { keep: 1, close: 0, defer: 0 },
      commit: null,
      adoptionStatus: "unchanged",
    }));
    render(<BacklogReview client={fakeClient({ review })} interactive onReviewed={() => {}} />);
    await screen.findByText("Ship the launch");

    fireEvent.click(screen.getByRole("radio", { name: "Leave open" }));
    fireEvent.click(screen.getByRole("button", { name: "Review selected" }));
    expect(screen.getByText(/Leave open is explicit, makes no Markdown change/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected" }));
    await waitFor(() => expect(screen.getByText(/Left open; nothing was committed/)).toBeDefined());
    expect(screen.getByText(/Leave-open choices are not stored/)).toBeDefined();
    expect(review).toHaveBeenCalledTimes(1);
    expect((review.mock.calls[0]![0] as { decisions: Array<{ disposition: string }> }).decisions[0]!.disposition).toBe("keep");
  });

  test("a stale cursor automatically discards choices and restarts page one honestly", async () => {
    const first = page({ total: 26, hasMore: true, nextCursor: "stale" });
    let calls = 0;
    const taskBacklog = mock(async (request: { limit?: number; cursor?: string }): Promise<TaskBacklog> => {
      calls++;
      if (request.cursor !== undefined) return {
        schema: "dome.daily.task-backlog.list/v1",
        status: "error",
        error: "stale-cursor",
        message: "Changed.",
      };
      return calls === 1 ? first : page({ items: [unit({ text: "Fresh first page" })] });
    });
    render(<BacklogReview client={fakeClient({ taskBacklog })} interactive onReviewed={() => {}} />);
    await screen.findByText("Ship the launch");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByText("Fresh first page")).toBeDefined());
    expect(screen.getByText(/changed while you were paging/i)).toBeDefined();
    expect(screen.getByText("0 selected")).toBeDefined();
    expect(taskBacklog).toHaveBeenCalledTimes(3);
  });

  test("a stale review resets automatically while conflicts discard choices", async () => {
    const stale = {
      schema: "dome.task-backlog.review/v1" as const,
      status: "error" as const,
      error: "stale-review" as const,
      message: "Adopted state changed.",
      retryable: false,
      recoveryRequired: false,
    };
    const taskBacklog = mock(async () => page());
    const review = mock(async (_request: unknown) => stale);
    render(<BacklogReview client={fakeClient({ taskBacklog, review })} interactive onReviewed={() => {}} />);
    await screen.findByText("Ship the launch");
    fireEvent.click(screen.getByRole("radio", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Review selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected" }));

    await waitFor(() => expect(screen.getByText(/changed before your review landed/i)).toBeDefined());
    expect(screen.getByText("0 selected")).toBeDefined();
    expect(taskBacklog).toHaveBeenCalledTimes(2);
  });

  test("a source conflict is distinct, clears choices, and requires refresh", async () => {
    const conflict = {
      schema: "dome.task-backlog.review/v1" as const,
      status: "error" as const,
      error: "conflict" as const,
      message: "The source moved ambiguously.",
      retryable: false,
      recoveryRequired: false,
    };
    const review = mock(async (_request: unknown) => conflict);
    render(<BacklogReview client={fakeClient({ review })} interactive onReviewed={() => {}} />);
    await screen.findByText("Ship the launch");
    fireEvent.click(screen.getByRole("radio", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Review selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected" }));

    await waitFor(() => expect(screen.getByText("Source conflict")).toBeDefined());
    expect(screen.getByText("0 selected")).toBeDefined();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh backlog" })).toBeDefined();
  });

  test("busy retries the same frozen request; outcome unknown never offers retry", async () => {
    const busy = {
      schema: "dome.task-backlog.review/v1" as const,
      status: "error" as const,
      error: "busy" as const,
      message: "Workspace is busy.",
      retryable: true,
      recoveryRequired: false,
    };
    const unknown = {
      schema: "dome.task-backlog.review/v1" as const,
      status: "error" as const,
      error: "outcome-unknown" as const,
      message: "Receipt could not be reconciled.",
      retryable: false,
      recoveryRequired: true,
    };
    const responses: TaskBacklogReviewResult[] = [busy, unknown];
    const review = mock(async (_request: unknown) => responses.shift()!);
    render(<BacklogReview client={fakeClient({ review })} interactive onReviewed={() => {}} />);
    await screen.findByText("Ship the launch");
    fireEvent.click(screen.getByRole("radio", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Review selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected" }));

    await waitFor(() => expect(screen.getByText("Home is busy")).toBeDefined());
    const firstBody = review.mock.calls[0]![0];
    fireEvent.click(screen.getByRole("button", { name: "Retry same batch" }));
    await waitFor(() => expect(screen.getByText("Outcome needs reconciliation")).toBeDefined());
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[1]![0]).toEqual(firstBody);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh backlog" })).toBeDefined();
    expect((screen.getByRole("radio", { name: "Close" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
  });

  test("revoking resolve access disables a busy retry and guards the frozen batch", async () => {
    const busy = {
      schema: "dome.task-backlog.review/v1" as const,
      status: "error" as const,
      error: "busy" as const,
      message: "Workspace is busy.",
      retryable: true,
      recoveryRequired: false,
    };
    const review = mock(async (_request: unknown) => busy);
    const client = fakeClient({ review });
    const rendered = render(<BacklogReview client={client} interactive onReviewed={() => {}} />);
    await screen.findByText("Ship the launch");
    fireEvent.click(screen.getByRole("radio", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Review selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected" }));
    await waitFor(() => expect(screen.getByText("Home is busy")).toBeDefined());
    expect(review).toHaveBeenCalledTimes(1);

    rendered.rerender(<BacklogReview client={client} interactive={false} onReviewed={() => {}} />);
    const retry = screen.getByRole("button", { name: "Retry same batch" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    await Promise.resolve();
    expect(review).toHaveBeenCalledTimes(1);
  });

  test("invalid requests are incompatible-client problems, not source conflicts", async () => {
    const invalid = {
      schema: "dome.task-backlog.review/v1" as const,
      status: "error" as const,
      error: "invalid-request" as const,
      message: "The review document was rejected.",
      retryable: false,
      recoveryRequired: false,
    };
    const review = mock(async (_request: unknown) => invalid);
    render(<BacklogReview client={fakeClient({ review })} interactive onReviewed={() => {}} />);
    await screen.findByText("Ship the launch");
    fireEvent.click(screen.getByRole("radio", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Review selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected" }));

    await waitFor(() => expect(screen.getByText("Review request incompatible")).toBeDefined());
    expect(screen.queryByText("Source conflict")).toBeNull();
    expect(screen.getByText(/update Dome Home and this PWA together/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Refresh backlog" })).toBeDefined();
    expect(screen.getByText("0 selected")).toBeDefined();
  });

  test("an ambiguous exact-match group visibly disables every disposition but leaves sources openable", async () => {
    const ambiguous = unit({
      duplicate: true,
      reviewable: false,
      members: [
        member({ id: "m1", path: "wiki/a.md", line: 3, blockId: "task-a", reviewable: true }),
        member({ id: "m2", path: "wiki/b.md", line: 8, blockId: "task-a", reviewable: false }),
      ],
    });
    const review = mock(async (_request: unknown) => settled());
    render(<BacklogReview client={fakeClient({ taskBacklog: async () => page({ items: [ambiguous] }), review })} interactive onReviewed={() => {}} />);
    await screen.findByText("Ship the launch");

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(6);
    expect(radios.every((radio) => (radio.closest("fieldset") as HTMLFieldSetElement).disabled)).toBe(true);
    expect(screen.getByText(/ambiguous identity/i)).toBeDefined();
    expect(screen.getByText(/appears more than once/i)).toBeDefined();
    expect((screen.getByRole("button", { name: "Alpha · wiki/a.md:3" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Review selected" }) as HTMLButtonElement).disabled).toBe(true);
    expect(review).not.toHaveBeenCalled();
  });

  test("revoking resolve access disables an already-open confirmation and guards submission", async () => {
    const review = mock(async (_request: unknown) => settled());
    const client = fakeClient({ review });
    const rendered = render(<BacklogReview client={client} interactive onReviewed={() => {}} />);
    await screen.findByText("Ship the launch");
    fireEvent.click(screen.getByRole("radio", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Review selected" }));
    const apply = screen.getByRole("button", { name: "Apply 1 selected" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);

    rendered.rerender(<BacklogReview client={client} interactive={false} onReviewed={() => {}} />);
    expect((screen.getByRole("button", { name: "Apply 1 selected" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected" }));
    await Promise.resolve();
    expect(review).not.toHaveBeenCalled();
  });
});
