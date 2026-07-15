import { useState } from "react";
import type { DomeClient } from "../api/client";
import type { Recents as RecentsT } from "../api/types";
import { SourceViewer } from "./SourceViewer";

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function Recents({ recents, client, interactive }: {
  recents: RecentsT;
  client: DomeClient;
  interactive: boolean;
}): React.ReactElement {
  const [opened, setOpened] = useState<{
    entry: RecentsT["entries"][number];
    trigger: HTMLButtonElement;
  } | null>(null);
  if (recents.count === 0) {
    return <div className="recents"><p className="empty">nothing recent</p></div>;
  }
  return (
    <div className="recents">
      <ul>
        {recents.entries.map((e) => {
          const who = e.changedBy === "engine" ? "engine" : "you";
          return (
            <li key={`${e.path}:${e.commit}`}>
              <button
                type="button"
                className="recent-entry"
                disabled={!interactive}
                onClick={(event) => setOpened({ entry: e, trigger: event.currentTarget })}
              >
                <span className={`rdot ${who}`} aria-hidden="true" />
                <span className="rbody">
                  <span className="title">{e.title}</span>
                  <span className="meta">{who} · {e.subject} · {ago(e.lastChangedAt)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {opened !== null ? (
        <SourceViewer
          citation={{ path: opened.entry.path, commit: opened.entry.commit }}
          client={client}
          returnFocus={opened.trigger}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </div>
  );
}
