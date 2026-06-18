import { useState } from "react";
import type { Citation } from "../api/types";
import type { ChatState } from "../chat/streamReducer";

/** Middle/tail-truncate long paths so chips don't blow out the row. */
function truncPath(p: string): string {
  if (p.length <= 24) return p;
  const parts = p.split("/");
  const file = parts[parts.length - 1] ?? p;
  if (file.length >= 22) return `…${file.slice(-21)}`;
  return `${parts[0] ?? ""}/…/${file}`;
}

function Chip({ path }: { path: string }): React.ReactElement {
  return <span className="chip"><span className="doc" aria-hidden="true" />{truncPath(path)}</span>;
}

function Cites({ citations }: { citations: Citation[] }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const SHOWN = 3;
  if (citations.length <= SHOWN || expanded) {
    return <div className="cites">{citations.map((c, i) => <Chip key={i} path={c.path} />)}</div>;
  }
  const head = citations.slice(0, SHOWN - 1);
  return (
    <div className="cites">
      {head.map((c, i) => <Chip key={i} path={c.path} />)}
      <button type="button" className="chip more" onClick={() => setExpanded(true)}>+{citations.length - head.length} sources</button>
    </div>
  );
}

export function ChatTranscript({ state }: { state: ChatState }): React.ReactElement {
  return (
    <div className="transcript">
      {state.messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          <p>{m.text}{m.streaming ? <span className="cursor" aria-hidden="true" /> : null}</p>
          {m.citations.length > 0 ? <Cites citations={m.citations} /> : null}
        </div>
      ))}
    </div>
  );
}
