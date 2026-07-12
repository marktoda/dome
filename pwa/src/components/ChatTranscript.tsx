import { useState } from "react";
import type { Citation } from "../api/types";
import type { ChatState } from "../chat/streamReducer";
import { renderMarkdown, renderRich } from "../rich";
import { SourceViewer } from "./SourceViewer";

/** Shorten long paths to "head/…/file.md" so chips stay one line. */
function shortPath(p: string): string {
  if (p.length <= 22) return p;
  const parts = p.split("/");
  return `${parts[0] ?? ""}/…/${parts[parts.length - 1] ?? p}`;
}

function Chip({ citation, onOpen }: {
  citation: Citation;
  onOpen: (element: HTMLButtonElement) => void;
}): React.ReactElement {
  return (
    <button type="button" className="chip" title={citation.path} onClick={(event) => onOpen(event.currentTarget)}>
      <span className="doc" aria-hidden="true" />{shortPath(citation.path)}
    </button>
  );
}

function Cites({ citations }: { citations: Citation[] }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState<{ citation: Citation; trigger: HTMLButtonElement } | null>(null);
  const MAX = 4;
  const visible = expanded ? citations : citations.slice(0, MAX);
  const hidden = citations.length - visible.length;
  return (
    <div className="cites">
      {visible.map((c, i) => <Chip key={i} citation={c} onOpen={(trigger) => setOpened({ citation: c, trigger })} />)}
      {hidden > 0 ? <button type="button" className="chip more" onClick={() => setExpanded(true)}>+{hidden} more</button> : null}
      {opened !== null ? (
        <SourceViewer
          citation={opened.citation}
          returnFocus={opened.trigger}
          onClose={() => setOpened(null)}
        />
      ) : null}
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
          {m.notice !== undefined ? <p className="turn-notice" role={m.noticeTone === "error" ? "alert" : "status"}>{m.notice}</p> : null}
        </div>
      ))}
    </div>
  );
}
