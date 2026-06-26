import { afterEach, describe, expect, test, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "../src/components/Composer";

afterEach(cleanup);

describe("Composer", () => {
  test("typing + send calls onAsk and clears the field", () => {
    const onAsk = mock(() => {});
    render(<Composer onAsk={onAsk} onTranscribe={async () => ""} onFile={async () => {}} />);
    const input = screen.getByPlaceholderText(/ask/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "what's open?" } });
    fireEvent.submit(input.closest("form")!);
    expect(onAsk).toHaveBeenCalledWith("what's open?");
    expect(input.value).toBe("");
  });

  test("mic button is present (recording support is feature-detected)", () => {
    render(<Composer onAsk={() => {}} onTranscribe={async () => ""} onFile={async () => {}} />);
    expect(screen.getByRole("button", { name: /record|mic|🎤/i })).toBeDefined();
  });
});
