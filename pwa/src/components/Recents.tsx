import type { Recents as RecentsT } from "../api/types";

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function Recents({ recents }: { recents: RecentsT }): React.ReactElement {
  if (recents.count === 0) {
    return <div className="recents"><p className="empty">nothing recent</p></div>;
  }
  return (
    <div className="recents">
      <ul>
        {recents.entries.map((e) => (
          <li key={e.path}>
            <span className="title">{e.title}</span>
            <span className="meta">
              <span className={e.changedBy === "engine" ? "who-engine" : ""}>{e.changedBy}</span> · {ago(e.lastChangedAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
