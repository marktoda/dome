import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.getByText(/updated/)).toBeTruthy();
    expect(screen.getByText(/todo\.md/)).toBeTruthy();
  });
});
