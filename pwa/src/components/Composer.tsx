import { useEffect, useReducer, useRef, useState } from "react";
import { captureReducer, INITIAL } from "../capture/captureMachine";
import { useModalFocus } from "../accessibility/modalFocus";
import type { ComposerPresentation } from "../connection/product-session";

type Props = {
  onAsk: (q: string) => void;
  turnPhase?: "idle" | "streaming" | "stopping" | "retryable" | "session-ended";
  onStop?: () => void;
  onRetry?: () => void;
  onNewConversation?: () => void;
  onCapture: (text: string) => Promise<string | void>;
  onTranscribe: (audio: Blob) => Promise<string>;
  availability?: "available" | "offline" | "unreachable";
  askEnabled?: boolean;
  voiceEnabled?: boolean;
  presentation?: ComposerPresentation;
};

function canRecord(): boolean {
  return (
  typeof navigator !== "undefined" &&
  typeof (navigator as Navigator).mediaDevices?.getUserMedia === "function" &&
  typeof MediaRecorder !== "undefined"
  );
}

const WAVE = [10, 18, 30, 44, 24, 36, 52, 28, 15, 33, 48, 22, 40, 56, 26, 13, 35, 46, 20, 30, 50, 24, 11, 38, 28, 44, 18, 32];

function fmtTime(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Composer({
  onAsk,
  turnPhase = "idle",
  onStop,
  onRetry,
  onNewConversation,
  onCapture,
  onTranscribe,
  availability = "available",
  askEnabled = true,
  voiceEnabled = true,
  presentation = { placeholder: "ask or capture…", hint: null },
}: Props): React.ReactElement {
  const [text, setText] = useState("");
  const [cap, dispatch] = useReducer(captureReducer, INITIAL);
  const [secs, setSecs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const availabilityRef = useRef(availability);
  const voiceEnabledRef = useRef(voiceEnabled);
  const discardRecordingRef = useRef(false);
  const captureContainerRef = useRef<HTMLElement>(null);
  const stopRecordingRef = useRef<HTMLButtonElement>(null);
  const reviewTextareaRef = useRef<HTMLTextAreaElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);
  availabilityRef.current = availability;
  voiceEnabledRef.current = voiceEnabled;

  const captureModalActive = cap.phase === "recording" || cap.phase === "transcribing" || cap.phase === "review" || cap.phase === "saving";
  const captureFocusKey = cap.phase;
  useModalFocus({
    active: captureModalActive,
    focusKey: captureFocusKey,
    containerRef: captureContainerRef,
    initialFocus: () => cap.phase === "recording"
      ? stopRecordingRef.current
      : cap.phase === "review"
        ? reviewTextareaRef.current
        : captureContainerRef.current,
    onEscape: () => {
      if (cap.phase === "recording") recorderRef.current?.stop();
      else if (cap.phase === "review") dispatch({ kind: "cancel" });
    },
    restoreFocus: () => composerInputRef.current,
  });

  useEffect(() => {
    const recorder = recorderRef.current;
    if ((availability !== "available" || !voiceEnabled) && recorder !== null && recorder.state !== "inactive") {
      discardRecordingRef.current = true;
      recorder.stop();
    }
  }, [availability, voiceEnabled]);

  useEffect(() => {
    if (cap.phase !== "recording") { setSecs(0); return; }
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [cap.phase]);

  const startRecording = async (): Promise<void> => {
    try {
      if (availabilityRef.current !== "available" || !voiceEnabledRef.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (availabilityRef.current !== "available" || !voiceEnabledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        dispatch({ kind: "fail", error: "Recording discarded because Dome Home is unavailable." });
        return;
      }
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const discard = discardRecordingRef.current || availabilityRef.current !== "available" || !voiceEnabledRef.current;
        discardRecordingRef.current = false;
        const recordedChunks = chunksRef.current;
        chunksRef.current = [];
        if (discard) {
          dispatch({ kind: "fail", error: "Recording discarded because Dome Home is unavailable." });
          return;
        }
        dispatch({ kind: "stop-recording" });
        try {
          const blob = new Blob(recordedChunks, { type: rec.mimeType || "audio/webm" });
          dispatch({ kind: "transcribed", text: await onTranscribe(blob) });
        } catch (e) { dispatch({ kind: "fail", error: e instanceof Error ? e.message : String(e) }); }
      };
      recorderRef.current = rec;
      rec.start();
      dispatch({ kind: "start-recording" });
    } catch (e) { dispatch({ kind: "fail", error: e instanceof Error ? e.message : String(e) }); }
  };

  const saveLocally = async (): Promise<void> => {
    if (cap.draft.trim().length === 0) return;
    dispatch({ kind: "save" });
    try {
      await onCapture(cap.draft);
      setText("");
      dispatch({ kind: "saved" });
    } catch (e) { dispatch({ kind: "fail", error: e instanceof Error ? e.message : String(e) }); }
  };

  if (cap.phase === "recording") {
    return (
      <section ref={captureContainerRef} className="overlay" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="recording-title">
        <div className="center">
          <div className="rec-tag"><span className="dot" /><span id="recording-title" className="label">LISTENING</span></div>
          <div className="waveform">
            {WAVE.map((h, i) => <div key={i} className="bar" style={{ height: `${h}px`, animationDelay: `${(i * 0.045).toFixed(3)}s` }} />)}
          </div>
          <div className="timer">{fmtTime(secs)}</div>
          <div className="hint">tap to stop &amp; review</div>
        </div>
        <div className="rec-controls">
          <button ref={stopRecordingRef} type="button" className="rec-btn" aria-label="stop recording" onClick={() => recorderRef.current?.stop()}><span className="stop" /></button>
        </div>
      </section>
    );
  }

  if (cap.phase === "transcribing") {
    return (
      <section ref={captureContainerRef} className="overlay" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="transcribing-title" aria-busy="true">
        <div className="center">
          <div className="spinner" />
          <div id="transcribing-title" className="transcribing-label" role="status" aria-live="polite">Transcribing recording…</div>
          <div className="shimmer-lines"><div className="line" style={{ width: "90%" }} /><div className="line" style={{ width: "70%" }} /></div>
        </div>
      </section>
    );
  }

  if (cap.phase === "review" || cap.phase === "saving") {
    const saving = cap.phase === "saving";
    return (
      <div className="sheet-backdrop">
        <section ref={captureContainerRef} className="sheet" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="capture-review-title">
          <div className="grip" />
          <div className="tag"><span className="dot" /><span id="capture-review-title" className="label">CAPTURE A THOUGHT</span></div>
          <textarea ref={reviewTextareaRef} aria-label="capture draft" value={cap.draft} disabled={saving} onChange={(e) => dispatch({ kind: "edit", text: e.target.value })} />
          <div className="actions">
            <button type="button" className="cancel" disabled={saving} onClick={() => dispatch({ kind: "cancel" })}>Cancel</button>
            <button
              type="button"
              className="record-capture"
              disabled={saving || !canRecord() || availability !== "available" || !voiceEnabled}
              onClick={() => { void startRecording(); }}
            >Record voice</button>
            <button type="button" className="save-capture" disabled={saving || cap.draft.trim().length === 0} onClick={() => { void saveLocally(); }}>{saving ? "Saving locally…" : "Save capture"}</button>
          </div>
        </section>
      </div>
    );
  }

  // idle
  const activeTurn = turnPhase === "streaming" || turnPhase === "stopping";
  const remoteAvailable = availability === "available";
  const askBlocked = activeTurn || turnPhase === "session-ended" || !remoteAvailable || !askEnabled;
  return (
    <form className="composer" aria-label="Message composer" onSubmit={(e) => { e.preventDefault(); const q = text.trim(); if (!askBlocked && q.length > 0) { onAsk(q); setText(""); } }}>
      {activeTurn ? (
        <div className="turn-control" role="status" aria-live="polite">
          <span>{turnPhase === "stopping" ? "Stopping…" : "Thinking…"}</span>
          <button type="button" onClick={onStop} disabled={turnPhase === "stopping"} aria-label="stop response">
            {turnPhase === "stopping" ? "Stopping" : "Stop"}
          </button>
        </div>
      ) : null}
      {turnPhase === "retryable" || turnPhase === "session-ended" ? (
        <div className="turn-control" role="status" aria-live="polite">
          <span>{turnPhase === "session-ended" ? "Conversation ended. Retry may repeat actions." : "Response interrupted; outcome may be uncertain. Retry may repeat actions."}</span>
          <button type="button" onClick={onRetry} disabled={!remoteAvailable || !askEnabled}>Retry question</button>
          <button type="button" onClick={onNewConversation} disabled={!remoteAvailable || !askEnabled}>New conversation</button>
        </div>
      ) : null}
      <div className="pill">
        <input ref={composerInputRef} aria-label="ask or capture" placeholder={presentation.placeholder} value={text} onChange={(e) => setText(e.target.value)} />
        <button
          type="button"
          className="capture-text"
          aria-label="Capture"
          onClick={() => {
            dispatch({ kind: "start-capture", text });
          }}
        >Capture</button>
        <button type="submit" aria-label="Ask" disabled={askBlocked || text.trim().length === 0} className={`send${text.trim().length > 0 ? " active" : ""}`}>Ask</button>
      </div>
      {presentation.hint === null ? null : <span className="connection-hint">{presentation.hint}</span>}
      {cap.error !== null ? <span className="err" role="alert">{cap.error}</span> : null}
    </form>
  );
}
