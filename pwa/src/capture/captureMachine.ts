export type CapturePhase = "idle" | "recording" | "transcribing" | "review" | "filing";
export type CaptureState = { phase: CapturePhase; draft: string; error: string | null };
export const INITIAL: CaptureState = { phase: "idle", draft: "", error: null };

export type CaptureAction =
  | { kind: "start-capture"; text: string }
  | { kind: "start-recording" } | { kind: "stop-recording" }
  | { kind: "transcribed"; text: string } | { kind: "edit"; text: string }
  | { kind: "file" } | { kind: "filed" }
  | { kind: "fail"; error: string } | { kind: "cancel" };

export function captureReducer(s: CaptureState, a: CaptureAction): CaptureState {
  switch (a.kind) {
    case "start-capture": return s.phase === "idle" ? { phase: "review", draft: a.text, error: null } : s;
    case "start-recording": return s.phase === "idle" || s.phase === "review" ? { phase: "recording", draft: "", error: null } : s;
    case "stop-recording": return s.phase === "recording" ? { ...s, phase: "transcribing" } : s;
    case "transcribed": return s.phase === "transcribing" ? { phase: "review", draft: a.text, error: null } : s;
    case "edit": return s.phase === "review" ? { ...s, draft: a.text } : s;
    case "file": return s.phase === "review" && s.draft.trim().length > 0 ? { ...s, phase: "filing" } : s;
    case "filed": return s.phase === "filing" ? INITIAL : s;
    case "fail": return { phase: "idle", draft: "", error: a.error };
    case "cancel": return INITIAL;
  }
}
