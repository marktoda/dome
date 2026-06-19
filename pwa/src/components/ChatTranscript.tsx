import { useState } from "react";
import type { Citation } from "../api/types";
import type { ChatState } from "../chat/streamReducer";
import { renderMarkdown, renderRich } from "../rich";

/** Shorten long paths to "head/…/file.md" so chips stay one line. */
function shortPath(p: string): string {
  if (p.length <= 22) return p;
  const parts = p.split("/");
  return `${parts[0] ?? ""}/…/${parts[parts.length - 1] ?? p}`;
}

function Chip({ path }: { path: string }): React.ReactElement {
  return <span className="chip"><span className="doc" aria-hidden="true" />{shortPath(path)}</span>;
}

function Cites({ citations }: { citations: Citation[] }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const MAX = 4;
  const visible = expanded ? citations : citations.slice(0, MAX);
  const hidden = citations.length - visible.length;
  return (
    <div className="cites">
      {visible.map((c, i) => <Chip key={i} path={c.path} />)}
      {hidden > 0 ? <button type="button" className="chip more" onClick={() => setExpanded(true)}>+{hidden} more</button> : null}
    </div>
  );
}

export function ChatTranscript({ state }: { state: ChatState }): React.ReactElement {
  return (
    <div className="transcript">
      {state.messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          {m.role === "assistant" ? (
            <div className="answer">{renderMarkdown(m.text)}{m.streaming ? <span className="cursor" aria-hidden="true" /> : null}</div>
          ) : (
            <p>{renderRich(m.text)}</p>
          )}
          {m.citations.length > 0 ? <Cites citations={m.citations} /> : null}
          {m.changes.length > 0 ? (
            <div className="changes">
              {m.changes.map((c, j) => (
                <span key={j} className="change">✎ {c.kind === "create" ? "created" : "updated"} {shortPath(c.path)}</span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
