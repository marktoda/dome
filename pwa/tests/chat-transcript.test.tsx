import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatTranscript } from "../src/components/ChatTranscript";

afterEach(cleanup);

describe("ChatTranscript", () => {
  test("renders messages and citation chips", () => {
    render(<ChatTranscript state={{ messages: [
      { role: "user", text: "q", citations: [], changes: [], streaming: false },
      { role: "assistant", text: "a", citations: [{ path: "wiki/x.md" }], changes: [], streaming: false },
    ] }} />);
    expect(screen.getByText("q")).toBeDefined();
    expect(screen.getByText("a")).toBeDefined();
    expect(screen.getByText(/wiki\/x\.md/)).toBeDefined();
  });
  test("renders a changes line for agent writes", () => {
    const state = { messages: [{ role: "assistant" as const, text: "Done.", citations: [], changes: [{ path: "wiki/todo.md", kind: "edit" as const }], streaming: false }] };
    render(<ChatTranscript state={state} />);
    expect(screen.getByText(/updated wiki\/todo\.md/)).toBeTruthy();
  });

  test("opens an exact citation as safe plain text and returns focus on Escape", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("path=wiki%2Fx.md");
      expect(String(input)).toContain("commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      return new Response(JSON.stringify({
        schema: "dome.source-document/v1",
        status: "ok",
        path: "wiki/x.md",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        content: "# Literal source\n\n<script>never active</script>",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      render(<ChatTranscript state={{ messages: [{
        role: "assistant",
        text: "answer",
        citations: [{ path: "wiki/x.md", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
        changes: [],
        streaming: false,
      }] }} />);
      const chip = screen.getByRole("button", { name: /wiki\/x\.md/ });
      fireEvent.click(chip);
      expect(screen.getByRole("dialog")).toBeDefined();
      expect(screen.getByText(/Revision aaaaaaaa/)).toBeDefined();
      const close = screen.getByRole("button", { name: "Close source" });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(close);
      await waitFor(() => expect(screen.getByText(/<script>never active<\/script>/)).toBeDefined());
      expect(document.querySelector(".source-body script")).toBeNull();
      expect(screen.getByText("Source loaded")).toBeDefined();
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
    }] }} />);
    fireEvent.click(screen.getByRole("button", { name: /wiki\/old\.md/ }));
    await waitFor(() => expect(screen.getByText(/did not include an exact source revision/i)).toBeDefined());
  });
});
