import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { DomeClient } from "../src/api/client";
import { ChatTranscript } from "../src/components/ChatTranscript";

afterEach(cleanup);

describe("ChatTranscript", () => {
  const client = new DomeClient();

  test("renders messages and citation chips", () => {
    render(<ChatTranscript state={{ messages: [
      { role: "user", text: "q", citations: [], changes: [], streaming: false },
      { role: "assistant", text: "a", citations: [{ path: "wiki/x.md" }], changes: [], streaming: false },
    ] }} client={client} />);
    expect(screen.getByText("q")).toBeDefined();
    expect(screen.getByText("a")).toBeDefined();
    expect(screen.getByText(/wiki\/x\.md/)).toBeDefined();
    expect(screen.getByRole("region", { name: "Conversation" }).hasAttribute("aria-live")).toBe(false);
  });
  test("renders a changes line for agent writes", () => {
    const state = { messages: [{ role: "assistant" as const, text: "Done.", citations: [], changes: [{ path: "wiki/todo.md", kind: "edit" as const }], streaming: false }] };
    render(<ChatTranscript state={state} client={client} />);
    expect(screen.getByText(/updated wiki\/todo\.md/)).toBeTruthy();
  });

  test("opens an exact citation as safe Markdown with an exact raw view and returns focus on Escape", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toContain("path=wiki%2Fx.md");
      expect(url).toContain("commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      return new Response(JSON.stringify({
        schema: "dome.source-document/v1",
        status: "ok",
        path: "wiki/x.md",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        content: "# Literal source\n\n<script>never active</script>",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      render(<StrictMode><ChatTranscript state={{ messages: [{
        role: "assistant",
        text: "answer",
        citations: [{ path: "wiki/x.md", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
        changes: [],
        streaming: false,
      }] }} client={client} /></StrictMode>);
      const chip = screen.getByRole("button", { name: /wiki\/x\.md/ });
      fireEvent.click(chip);
      expect(screen.getByRole("dialog")).toBeDefined();
      expect(screen.getByText(/rev aaaaaaaa/)).toBeDefined();
      const close = screen.getByRole("button", { name: "Close source" });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(screen.getByRole("dialog")).toBeDefined();
      expect(document.activeElement).toBe(close);
      await waitFor(() => expect(screen.getByText("Source loaded")).toBeDefined());
      const rendered = screen.getByRole("button", { name: "Rendered" });
      const raw = screen.getByRole("button", { name: "Raw" });
      expect(rendered.getAttribute("aria-pressed")).toBe("true");
      await waitFor(() => expect(screen.getByRole("heading", { name: "Literal source", level: 1 })).toBeDefined());
      expect(document.querySelector(".source-body script")).toBeNull();
      raw.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(raw);
      fireEvent.click(raw);
      expect(raw.getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByText(/<script>never active<\/script>/)).toBeDefined();
      expect(document.querySelector(".source-body script")).toBeNull();
      expect(document.querySelector(".source-body[aria-live]")).toBeNull();

      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(chip);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("explains citations that do not carry an exact commit", async () => {
    render(<ChatTranscript state={{ messages: [{
      role: "assistant", text: "answer", citations: [{ path: "wiki/old.md" }], changes: [], streaming: false,
    }] }} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: /wiki\/old\.md/ }));
    await waitFor(() => expect(screen.getByText(/did not include an exact source revision/i)).toBeDefined());
  });

  test("closing a loading source aborts locally without reporting Home unreachable", async () => {
    const originalFetch = globalThis.fetch;
    const failures: unknown[] = [];
    globalThis.fetch = (async (request: Request) => await new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("closed", "AbortError")), { once: true });
    })) as typeof fetch;
    const reportingClient = new DomeClient("", "", () => (cause) => { failures.push(cause); });
    try {
      render(<ChatTranscript state={{ messages: [{
        role: "assistant",
        text: "answer",
        citations: [{ path: "wiki/x.md", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
        changes: [],
        streaming: false,
      }] }} client={reportingClient} />);
      fireEvent.click(screen.getByRole("button", { name: /wiki\/x\.md/ }));
      await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: "Close source" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /wiki\/x\.md/ }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(failures).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
