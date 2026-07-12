import type { AgentChange, AgentStreamOutcome, Citation, StreamEvent } from "../api/types";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  citations: Citation[];
  changes: AgentChange[];
  streaming: boolean;
  turnId?: string;
  notice?: string;
  noticeTone?: "status" | "error";
};
export type ChatState = { messages: ChatMessage[] };
export type ChatAction =
  | { kind: "user"; text: string }
  | { kind: "assistant-start" }
  | { kind: "turn-start"; turnId: string; question: string }
  | { kind: "boundary"; text: string }
  | { kind: "event"; event: StreamEvent; turnId?: string }
  | { kind: "outcome"; turnId: string; outcome: AgentStreamOutcome };

function assistantIndex(messages: ChatMessage[], turnId?: string): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant" && (turnId === undefined || message.turnId === turnId)) return index;
  }
  return -1;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "user":
      return { messages: [...state.messages, { role: "user", text: action.text, citations: [], changes: [], streaming: false }] };
    case "assistant-start":
      return { messages: [...state.messages, { role: "assistant", text: "", citations: [], changes: [], streaming: true }] };
    case "turn-start":
      return { messages: [
        ...state.messages,
        { role: "user", text: action.question, citations: [], changes: [], streaming: false, turnId: action.turnId },
        { role: "assistant", text: "", citations: [], changes: [], streaming: true, turnId: action.turnId },
      ] };
    case "boundary":
      return { messages: [...state.messages, { role: "system", text: action.text, citations: [], changes: [], streaming: false }] };
    case "event": {
      const msgs = state.messages.slice();
      const index = assistantIndex(msgs, action.turnId);
      const last = msgs[index];
      if (last === undefined || last.role !== "assistant" || !last.streaming) return state;
      const e = action.event;
      if (e.type === "text") msgs[index] = { ...last, text: last.text + e.text };
      else if (e.type === "done") msgs[index] = { ...last, citations: e.citations, changes: e.changes ?? [], streaming: false };
      else msgs[index] = { ...last, notice: e.message, noticeTone: "error", streaming: false };
      return { messages: msgs };
    }
    case "outcome": {
      const msgs = state.messages.slice();
      const index = assistantIndex(msgs, action.turnId);
      const last = msgs[index];
      if (last === undefined) return state;
      const notice = action.outcome.kind === "cancelled"
        ? action.outcome.source === "server" ? "Cancellation confirmed by the server." : "Stop requested locally."
        : action.outcome.kind === "session-missing" || action.outcome.kind === "session-expired"
          ? "This conversation ended. Start a new conversation or retry when ready."
          : action.outcome.kind === "failed"
            ? action.outcome.message
            : last.notice;
      msgs[index] = { ...last, streaming: false, ...(notice !== undefined ? { notice } : {}) };
      if (action.outcome.kind === "failed" || action.outcome.kind === "session-missing" || action.outcome.kind === "session-expired") {
        msgs[index] = { ...msgs[index]!, noticeTone: "error" };
      } else if (action.outcome.kind === "cancelled") {
        msgs[index] = { ...msgs[index]!, noticeTone: "status" };
      }
      return { messages: msgs };
    }
  }
}
