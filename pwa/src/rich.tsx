// Render vault prose (tasks, brief, answers) that may carry lightweight markdown
// + [[wikilinks]] as clean content — never raw syntax.
//
// renderRich(text)     — INLINE: for one-line fields (task text, brief line, user msg).
// renderMarkdown(text) — BLOCK:  for answers (paragraphs + "- " lists), inline-rendered per line.
//
// Inline tokens handled:
//   **bold**          → <strong>
//   [label](url)      → a subtle tappable link (label only; the long URL is hidden)
//   [[Target]]        → clean concept label (last path segment, ".md" dropped)
//   [[Target|Label]]  → Label
//   [path/like]       → clean concept label (bare-bracket path citations the agent emits)
// Not a full markdown parser — just the patterns Dome content actually uses.

const TOKEN = /\*\*([^*]+)\*\*|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)|\[([^\]]*(?:\/|\.md)[^\]]*)\](?!\()/g;

function conceptLabel(inner: string): string {
  const afterPipe = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : inner;
  const base = afterPipe.includes("/") ? afterPipe.slice(afterPipe.lastIndexOf("/") + 1) : afterPipe;
  return base.replace(/\.md$/, "").trim();
}

export function renderRich(text: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<strong key={key++}>{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      out.push(<span key={key++} className="wl">{conceptLabel(m[2])}</span>);
    } else if (m[3] !== undefined && m[4] !== undefined) {
      out.push(<a key={key++} className="wl" href={m[4]} target="_blank" rel="noopener noreferrer">{m[3]}</a>);
    } else if (m[5] !== undefined) {
      out.push(<span key={key++} className="wl">{conceptLabel(m[5])}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 0 ? text : out;
}

export function renderMarkdown(text: string): React.ReactNode {
  const blocks: React.ReactNode[] = [];
  let items: React.ReactNode[] = [];
  let key = 0;
  const flush = (): void => {
    if (items.length > 0) { blocks.push(<ul key={`u${key++}`}>{items}</ul>); items = []; }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const li = /^[-*]\s+(.+)$/.exec(line);
    if (li !== null) { items.push(<li key={key++}>{renderRich(li[1] ?? "")}</li>); continue; }
    flush();
    if (line === "") continue;
    blocks.push(<p key={key++}>{renderRich(line)}</p>);
  }
  flush();
  return blocks.length > 0 ? blocks : renderRich(text);
}
