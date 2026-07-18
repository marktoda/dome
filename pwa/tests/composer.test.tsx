import { afterEach, describe, expect, test, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import { expectModalFocusRestored } from "./support/modal-focus";

afterEach(cleanup);

describe("Composer", () => {
  test("typing + send calls onAsk and clears the field", () => {
    const onAsk = mock(() => {});
    render(<Composer onAsk={onAsk} onCapture={async () => {}} onTranscribe={async () => ""} />);
    const input = screen.getByPlaceholderText(/ask/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "what's open?" } });
    fireEvent.submit(input.closest("form")!);
    expect(onAsk).toHaveBeenCalledWith("what's open?");
    expect(input.value).toBe("");
  });

  test("Capture opens the separate text and voice sheet", () => {
    render(<Composer onAsk={() => {}} onCapture={async () => {}} onTranscribe={async () => ""} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    expect(screen.getByRole("dialog", { name: "CAPTURE A THOUGHT" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Record voice" })).toBeDefined();
  });

  test("an active turn disables asks and exposes an accessible stop control", () => {
    const onAsk = mock(() => {});
    const onStop = mock(() => {});
    render(<Composer turnPhase="streaming" onAsk={onAsk} onStop={onStop} onCapture={async () => {}} onTranscribe={async () => ""} />);
    expect((screen.getByLabelText("ask or capture") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "stop response" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("stopping remains visible and cannot issue a second stop", () => {
    render(<Composer turnPhase="stopping" onAsk={() => {}} onStop={() => {}} onCapture={async () => {}} onTranscribe={async () => ""} />);
    expect(screen.getByText("Stopping…")).toBeDefined();
    expect((screen.getByRole("button", { name: "stop response" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("retry and new conversation are explicit controls", () => {
    const onRetry = mock(() => {});
    const onNewConversation = mock(() => {});
    render(<Composer turnPhase="session-ended" onAsk={() => {}} onRetry={onRetry} onNewConversation={onNewConversation} onCapture={async () => {}} onTranscribe={async () => ""} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry question" }));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  test("offline keeps text capture available while Ask, voice, and retry stay disabled", () => {
    const capture = mock(async () => {});
    const ask = mock(() => {});
    render(<Composer availability="offline" turnPhase="retryable" onAsk={ask} onCapture={capture} onTranscribe={async () => ""} />);
    const input = screen.getByLabelText("ask or capture") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "save this offline" } });
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Retry question" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    expect((screen.getByRole("button", { name: "Record voice" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save capture" }));
    expect(capture).toHaveBeenCalledWith("save this offline");
    expect(ask).not.toHaveBeenCalled();
  });

  test("paints the feature cause supplied by the product session", () => {
    const props = {
      onAsk: () => {},
      onCapture: async () => {},
      onTranscribe: async () => "",
    };
    render(<Composer
      {...props}
      askEnabled={false}
      voiceEnabled={false}
      presentation={{
        placeholder: "ask or capture…",
        hint: "Pair this device again to use Ask and voice. Text capture stays on this device.",
      }}
    />);
    expect(screen.getByText(/Pair this device again/i)).toBeDefined();
    expect(screen.getByPlaceholderText("ask or capture…")).toBeDefined();
    expect(screen.queryByText(/setup/i)).toBeNull();
  });

  test("an availability loss while recording discards audio without transcription", async () => {
    const originalRecorder = globalThis.MediaRecorder;
    const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    const stopTrack = mock(() => {});
    class FakeRecorder {
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start(): void { this.state = "recording"; }
      stop(): void { this.state = "inactive"; queueMicrotask(() => this.onstop?.()); }
    }
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) },
    });
    globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
    const transcribe = mock(async () => "must not run");
    try {
      const view = render(<Composer availability="available" onAsk={() => {}} onCapture={async () => {}} onTranscribe={transcribe} />);
      fireEvent.click(screen.getByRole("button", { name: "Capture" }));
      fireEvent.click(screen.getByRole("button", { name: "Record voice" }));
      await waitFor(() => expect(screen.getByText("LISTENING")).toBeDefined());
      view.rerender(<Composer availability="unreachable" onAsk={() => {}} onCapture={async () => {}} onTranscribe={transcribe} />);
      await waitFor(() => expect(screen.getByText(/Recording discarded because Dome Home is unavailable/i)).toBeDefined());
      expect(transcribe).not.toHaveBeenCalled();
      expect(stopTrack).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.MediaRecorder = originalRecorder;
      if (originalMediaDevices === undefined) Reflect.deleteProperty(navigator, "mediaDevices");
      else Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    }
  });

  test("an online recording snapshots non-empty bytes before clearing its buffer", async () => {
    const originalRecorder = globalThis.MediaRecorder;
    const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    class FakeRecorder {
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start(): void { this.state = "recording"; }
      stop(): void {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["recorded audio"]) } as BlobEvent);
        queueMicrotask(() => this.onstop?.());
      }
    }
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
    });
    globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
    let receivedBytes = 0;
    const transcribe = mock(async (audio: Blob) => { receivedBytes = audio.size; return "heard"; });
    const file = mock(async () => {});
    try {
      render(<Composer availability="available" onAsk={() => {}} onCapture={file} onTranscribe={transcribe} />);
      fireEvent.click(screen.getByRole("button", { name: "Capture" }));
      fireEvent.click(screen.getByRole("button", { name: "Record voice" }));
      await waitFor(() => expect(screen.getByText("LISTENING")).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: "stop recording" }));
      await waitFor(() => expect(screen.getByLabelText("capture draft")).toBeDefined());
      expect(receivedBytes).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("button", { name: "Save capture" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.queryByText("Captured")).toBeNull();
      expect(screen.queryByText(/Filed to your inbox/i)).toBeNull();
      await expectModalFocusRestored(screen.getByLabelText("ask or capture"));
    } finally {
      globalThis.MediaRecorder = originalRecorder;
      if (originalMediaDevices === undefined) Reflect.deleteProperty(navigator, "mediaDevices");
      else Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    }
  });

  test("capture dialogs focus, contain, Escape, and restore through one modal seam", async () => {
    const originalRecorder = globalThis.MediaRecorder;
    const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    let resolveTranscript!: (text: string) => void;
    class FakeRecorder {
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start(): void { this.state = "recording"; }
      stop(): void {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"]) } as BlobEvent);
        queueMicrotask(() => this.onstop?.());
      }
    }
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
    });
    globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
    try {
      render(<Composer availability="available" onAsk={() => {}} onCapture={async () => {}} onTranscribe={async () => await new Promise<string>((resolve) => { resolveTranscript = resolve; })} />);
      fireEvent.click(screen.getByRole("button", { name: "Capture" }));
      fireEvent.click(screen.getByRole("button", { name: "Record voice" }));
      await screen.findByRole("dialog", { name: "LISTENING" });
      const stop = screen.getByRole("button", { name: "stop recording" });
      expect(document.activeElement).toBe(stop);
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(stop);
      fireEvent.keyDown(document, { key: "Escape" });

      const transcribing = await screen.findByRole("dialog", { name: "Transcribing recording…" });
      expect(transcribing.getAttribute("aria-busy")).toBe("true");
      expect(document.activeElement).toBe(transcribing);
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(transcribing);

      resolveTranscript("heard words");
      const review = await screen.findByRole("dialog", { name: /capture a thought/i });
      const textarea = screen.getByLabelText("capture draft");
      const fileButton = screen.getByRole("button", { name: "Save capture" });
      expect(document.activeElement).toBe(textarea);
      fileButton.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(textarea);
      textarea.focus();
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(fileButton);
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await expectModalFocusRestored(screen.getByLabelText("ask or capture"));
      expect(review.isConnected).toBe(false);
    } finally {
      globalThis.MediaRecorder = originalRecorder;
      if (originalMediaDevices === undefined) Reflect.deleteProperty(navigator, "mediaDevices");
      else Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    }
  });
});
