import type { Today, TodayItem, TodayQuestion } from "../api/types";

function Item({ item }: { item: TodayItem }): React.ReactElement {
  return (
    <li className="item">
      <span>{item.text}</span>
      {item.dueDate !== null ? <span className="due"> · due {item.dueDate}</span> : null}
    </li>
  );
}

function Question({ q, onResolve }: { q: TodayQuestion; onResolve: (id: number, value: string) => void }): React.ReactElement {
  return (
    <li className="question">
      <div>{q.question}</div>
      <div className="options">
        {q.options.map((opt) => (
          <button key={opt} type="button" onClick={() => onResolve(q.id, opt)}>{opt}</button>
        ))}
      </div>
    </li>
  );
}

export function Brief({ today, onResolve }: { today: Today; onResolve: (id: number, value: string) => void }): React.ReactElement {
  const open = today.counts.openTasks + today.counts.followups + today.counts.questions;
  return (
    <section className="brief">
      <header>today · {open === 0 ? "all clear" : `${open} open`}</header>
      {open === 0 ? <p className="all-clear">You&apos;re clear.</p> : null}
      {today.brief !== null ? <p className="brief-text">{today.brief.text}</p> : null}
      {today.hero !== null ? <div className="hero">⚠ {"text" in today.hero.item ? today.hero.item.text : today.hero.item.question}</div> : null}
      {today.openTasks.length > 0 ? <ul>{today.openTasks.map((t, i) => <Item key={`${t.path}:${t.line}:${i}`} item={t} />)}</ul> : null}
      {today.followups.length > 0 ? <ul className="followups">{today.followups.map((t, i) => <Item key={`f${t.path}:${t.line}:${i}`} item={t} />)}</ul> : null}
      {today.questions.length > 0 ? <ul className="questions">{today.questions.map((q) => <Question key={q.id} q={q} onResolve={onResolve} />)}</ul> : null}
    </section>
  );
}
