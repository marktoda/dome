import type { AgentChange, Citation, StreamEvent } from "../api/types";

export type ChatMessage = { role: "user" | "assistant"; text: string; citations: Citation[]; changes: AgentChange[]; streaming: boolean };
export type ChatState = { messages: ChatMessage[] };
export type ChatAction =
  | { kind: "user"; text: string }
  | { kind: "assistant-start" }
  | { kind: "event"; event: StreamEvent };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "user":
      return { messages: [...state.messages, { role: "user", text: action.text, citations: [], changes: [], streaming: false }] };
    case "assistant-start":
      return { messages: [...state.messages, { role: "assistant", text: "", citations: [], changes: [], streaming: true }] };
    case "event": {
      const msgs = state.messages.slice();
      const last = msgs[msgs.length - 1];
      if (last === undefined || last.role !== "assistant") return state;
      const e = action.event;
      if (e.type === "text") msgs[msgs.length - 1] = { ...last, text: last.text + e.text };
      else if (e.type === "done") msgs[msgs.length - 1] = { ...last, citations: e.citations, changes: e.changes ?? [], streaming: false };
      else msgs[msgs.length - 1] = { ...last, text: `${last.text} [error: ${e.message}]`, streaming: false };
      return { messages: msgs };
    }
  }
}
