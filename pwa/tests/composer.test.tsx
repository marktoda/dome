import { afterEach, describe, expect, test, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "../src/components/Composer";

afterEach(cleanup);

describe("Composer", () => {
  test("typing + send calls onAsk and clears the field", () => {
    const onAsk = mock(() => {});
    render(<Composer onAsk={onAsk} onCapture={async () => {}} onTranscribe={async () => ""} onFile={async () => {}} />);
    const input = screen.getByPlaceholderText(/ask/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "what's open?" } });
    fireEvent.submit(input.closest("form")!);
    expect(onAsk).toHaveBeenCalledWith("what's open?");
    expect(input.value).toBe("");
  });

  test("mic button is present (recording support is feature-detected)", () => {
    render(<Composer onAsk={() => {}} onCapture={async () => {}} onTranscribe={async () => ""} onFile={async () => {}} />);
    expect(screen.getByRole("button", { name: /record|mic|🎤/i })).toBeDefined();
  });

  test("an active turn disables asks and exposes an accessible stop control", () => {
    const onAsk = mock(() => {});
    const onStop = mock(() => {});
    render(<Composer turnPhase="streaming" onAsk={onAsk} onStop={onStop} onCapture={async () => {}} onTranscribe={async () => ""} onFile={async () => {}} />);
    expect((screen.getByLabelText("ask your brain") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "stop response" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("stopping remains visible and cannot issue a second stop", () => {
    render(<Composer turnPhase="stopping" onAsk={() => {}} onStop={() => {}} onCapture={async () => {}} onTranscribe={async () => ""} onFile={async () => {}} />);
    expect(screen.getByText("Stopping…")).toBeDefined();
    expect((screen.getByRole("button", { name: "stop response" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("retry and new conversation are explicit controls", () => {
    const onRetry = mock(() => {});
    const onNewConversation = mock(() => {});
    render(<Composer turnPhase="session-ended" onAsk={() => {}} onRetry={onRetry} onNewConversation={onNewConversation} onCapture={async () => {}} onTranscribe={async () => ""} onFile={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry question" }));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });
});
