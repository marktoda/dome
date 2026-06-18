// Render vault prose (tasks, brief, answers) that may contain lightweight
// markdown + [[wikilinks]] as clean inline content — never raw syntax:
//   **bold**          → <strong>
//   [label](url)      → a subtle tappable link (label only; the long URL is hidden)
//   [[Target]]        → clean concept label (last path segment, ".md" dropped)
//   [[Target|Label]]  → Label
// Not a full markdown parser — just the patterns Dome content actually uses.

const TOKEN = /\*\*([^*]+)\*\*|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)/g;

function wikiLabel(inner: string): string {
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
      out.push(<span key={key++} className="wl">{wikiLabel(m[2])}</span>);
    } else if (m[3] !== undefined && m[4] !== undefined) {
      out.push(<a key={key++} className="wl" href={m[4]} target="_blank" rel="noopener noreferrer">{m[3]}</a>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 0 ? text : out;
}
