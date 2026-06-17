import { useReducer, useRef, useState } from "react";
import { captureReducer, INITIAL } from "../capture/captureMachine";

type Props = {
  onAsk: (q: string) => void;
  onTranscribe: (audio: Blob) => Promise<string>;
  onFile: (text: string) => Promise<void>;
};

const canRecord = typeof navigator !== "undefined" && typeof (navigator as Navigator).mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";

export function Composer({ onAsk, onTranscribe, onFile }: Props): React.ReactElement {
  const [text, setText] = useState("");
  const [cap, dispatch] = useReducer(captureReducer, INITIAL);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

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
    dispatch({ kind: "file" });
    try { await onFile(cap.draft); dispatch({ kind: "filed" }); }
    catch (e) { dispatch({ kind: "fail", error: e instanceof Error ? e.message : String(e) }); }
  };

  if (cap.phase === "review") {
    return (
      <div className="composer review">
        <textarea value={cap.draft} onChange={(e) => dispatch({ kind: "edit", text: e.target.value })} aria-label="capture draft" />
        <button type="button" onClick={file}>File</button>
        <button type="button" onClick={() => dispatch({ kind: "cancel" })}>Cancel</button>
      </div>
    );
  }

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); const q = text.trim(); if (q.length > 0) { onAsk(q); setText(""); } }}>
      <button type="button" aria-label="record" disabled={!canRecord || cap.phase !== "idle"}
        onClick={() => { if (cap.phase === "idle") void startRecording(); else recorderRef.current?.stop(); }}>
        {cap.phase === "recording" ? "■" : "🎤"}
      </button>
      <input placeholder="ask your brain…" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" aria-label="send">↦</button>
      {cap.error !== null ? <span className="err">{cap.error}</span> : null}
      {cap.phase === "transcribing" ? <span className="status">transcribing…</span> : null}
    </form>
  );
}
