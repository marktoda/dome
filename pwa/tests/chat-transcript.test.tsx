import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatTranscript } from "../src/components/ChatTranscript";

afterEach(cleanup);

describe("ChatTranscript", () => {
  test("renders messages and citation chips", () => {
    render(<ChatTranscript state={{ messages: [
      { role: "user", text: "q", citations: [], streaming: false },
      { role: "assistant", text: "a", citations: [{ path: "wiki/x.md" }], streaming: false },
    ] }} />);
    expect(screen.getByText("q")).toBeDefined();
    expect(screen.getByText("a")).toBeDefined();
    expect(screen.getByText(/wiki\/x\.md/)).toBeDefined();
  });
});
