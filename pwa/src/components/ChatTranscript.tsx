import type { ChatState } from "../chat/streamReducer";

export function ChatTranscript({ state }: { state: ChatState }): React.ReactElement {
  return (
    <div className="transcript">
      {state.messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          <p>{m.text}{m.streaming ? <span className="cursor">▍</span> : null}</p>
          {m.citations.length > 0 ? (
            <div className="cites">{m.citations.map((c) => <span key={c.path} className="chip">{c.path}</span>)}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
