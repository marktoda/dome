import { useEffect, useReducer, useRef, useState } from "react";
import { captureReducer, INITIAL } from "../capture/captureMachine";

type Props = {
  onAsk: (q: string) => void;
  turnPhase?: "idle" | "streaming" | "stopping" | "retryable" | "session-ended";
  onStop?: () => void;
  onRetry?: () => void;
  onNewConversation?: () => void;
  onCapture: (text: string) => Promise<string | void>;
  onTranscribe: (audio: Blob) => Promise<string>;
  onFile: (text: string) => Promise<string | void>;
};

const canRecord =
  typeof navigator !== "undefined" &&
  typeof (navigator as Navigator).mediaDevices?.getUserMedia === "function" &&
  typeof MediaRecorder !== "undefined";

const WAVE = [10, 18, 30, 44, 24, 36, 52, 28, 15, 33, 48, 22, 40, 56, 26, 13, 35, 46, 20, 30, 50, 24, 11, 38, 28, 44, 18, 32];

function fmtTime(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Composer({ onAsk, turnPhase = "idle", onStop, onRetry, onNewConversation, onCapture, onTranscribe, onFile }: Props): React.ReactElement {
  const [text, setText] = useState("");
  const [cap, dispatch] = useReducer(captureReducer, INITIAL);
  const [secs, setSecs] = useState(0);
  const [captured, setCaptured] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (cap.phase !== "recording") { setSecs(0); return; }
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [cap.phase]);

  const startRecording = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        dispatch({ kind: "stop-recording" });
        try {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
          dispatch({ kind: "transcribed", text: await onTranscribe(blob) });
        } catch (e) { dispatch({ kind: "fail", error: e instanceof Error ? e.message : String(e) }); }
      };
      recorderRef.current = rec;
      rec.start();
      dispatch({ kind: "start-recording" });
    } catch (e) { dispatch({ kind: "fail", error: e instanceof Error ? e.message : String(e) }); }
  };

  const file = async (): Promise<void> => {
    if (cap.draft.trim().length === 0) return;
    dispatch({ kind: "file" });
    try {
      const path = await onFile(cap.draft);
      setCaptured(typeof path === "string" ? path : "");
      setTimeout(() => { setCaptured(null); dispatch({ kind: "filed" }); }, 1600);
    } catch (e) { dispatch({ kind: "fail", error: e instanceof Error ? e.message : String(e) }); }
  };

  // Captured confirmation (B5) — supersedes the sheet while it shows.
  if (captured !== null) {
    return (
      <div className="overlay captured">
        <div className="center">
          <div className="check"><span className="mark" /></div>
          <h2>Captured</h2>
          <p>Filed to your inbox. The engine will sort it.</p>
          {captured.length > 0 ? <div className="path">{captured}</div> : null}
        </div>
      </div>
    );
  }

  if (cap.phase === "recording") {
    return (
      <div className="overlay">
        <div className="center">
          <div className="rec-tag"><span className="dot" /><span className="label">LISTENING</span></div>
          <div className="waveform">
            {WAVE.map((h, i) => <div key={i} className="bar" style={{ height: `${h}px`, animationDelay: `${(i * 0.045).toFixed(3)}s` }} />)}
          </div>
          <div className="timer">{fmtTime(secs)}</div>
          <div className="hint">tap to stop &amp; review</div>
        </div>
        <div className="rec-controls">
          <button type="button" className="rec-btn" aria-label="stop recording" onClick={() => recorderRef.current?.stop()}><span className="stop" /></button>
        </div>
      </div>
    );
  }

  if (cap.phase === "transcribing") {
    return (
      <div className="overlay">
        <div className="center">
          <div className="spinner" />
          <div className="transcribing-label">transcribing…</div>
          <div className="shimmer-lines"><div className="line" style={{ width: "90%" }} /><div className="line" style={{ width: "70%" }} /></div>
        </div>
      </div>
    );
  }

  if (cap.phase === "review" || cap.phase === "filing") {
    const filing = cap.phase === "filing";
    return (
      <div className="sheet-backdrop">
        <div className="sheet">
          <div className="grip" />
          <div className="tag"><span className="dot" /><span className="label">HEARD THIS — FIX IF NEEDED</span></div>
          <textarea aria-label="capture draft" value={cap.draft} disabled={filing} onChange={(e) => dispatch({ kind: "edit", text: e.target.value })} />
          <div className="actions">
            <button type="button" className="cancel" disabled={filing} onClick={() => dispatch({ kind: "cancel" })}>Cancel</button>
            <button type="button" className="fileit" disabled={filing} onClick={() => { void file(); }}>{filing ? "Filing…" : "File it"}</button>
          </div>
        </div>
      </div>
    );
  }

  // idle
  const activeTurn = turnPhase === "streaming" || turnPhase === "stopping";
  const askBlocked = activeTurn || turnPhase === "session-ended";
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); const q = text.trim(); if (!askBlocked && q.length > 0) { onAsk(q); setText(""); } }}>
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
          <button type="button" onClick={onRetry}>Retry question</button>
          <button type="button" onClick={onNewConversation}>New conversation</button>
        </div>
      ) : null}
      <div className="pill">
        <button type="button" className="mic" aria-label="record" disabled={!canRecord || askBlocked} onClick={() => { void startRecording(); }}>
          <span className="glyph"><span className="stem" /><span className="base" /></span>
        </button>
        <input aria-label="ask your brain" placeholder="ask your brain…" value={text} disabled={askBlocked} onChange={(e) => setText(e.target.value)} />
        <button
          type="button"
          className="capture-text"
          aria-label="capture thought"
          disabled={askBlocked || text.trim().length === 0}
          onClick={() => {
            const draft = text.trim();
            if (draft.length > 0) void onCapture(draft).then(() => setText(""));
          }}
        >+</button>
        <button type="submit" disabled={askBlocked || text.trim().length === 0} className={`send${text.trim().length > 0 ? " active" : ""}`} aria-label="send">↑</button>
      </div>
      {cap.error !== null ? <span className="err">{cap.error}</span> : null}
    </form>
  );
}
