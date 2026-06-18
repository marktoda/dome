import type { Today, TodayItem, TodayQuestion } from "../api/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-20" → "Jun 20". Deterministic (no Date / timezone). */
function fmtDue(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m === null) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? ""} ${Number(m[3])}`;
}

function TaskRow({ item, followup = false }: { item: TodayItem; followup?: boolean }): React.ReactElement {
  return (
    <div className={`row${followup ? " followup" : ""}`}>
      <div className="box" />
      <div className="text">{item.text}</div>
      {item.dueDate !== null ? <span className="due">{fmtDue(item.dueDate)}</span> : null}
    </div>
  );
}

function QuestionCard({ q, onResolve }: { q: TodayQuestion; onResolve: (id: number, value: string) => void }): React.ReactElement {
  return (
    <div className="qcard">
      <div className="tag"><span className="q">?</span><span className="label">DECIDE</span></div>
      <div className="body">{q.question}</div>
      <div className="opts">
        {q.options.map((opt) => (
          <button key={opt} type="button" onClick={() => onResolve(q.id, opt)}>{opt}</button>
        ))}
      </div>
    </div>
  );
}

function HeroCard({ hero, onResolve }: { hero: NonNullable<Today["hero"]>; onResolve: (id: number, value: string) => void }): React.ReactElement {
  let inner: React.ReactNode;
  if (hero.kind === "question") {
    const q = hero.item as TodayQuestion;
    inner = (
      <>
        <div className="body">{q.question}</div>
        <div className="opts">
          {q.options.map((opt) => (
            <button key={opt} type="button" onClick={() => onResolve(q.id, opt)}>{opt}</button>
          ))}
        </div>
      </>
    );
  } else {
    const t = hero.item as TodayItem;
    inner = <div className="body">{t.text}{t.dueDate !== null ? <span className="due">{fmtDue(t.dueDate)}</span> : null}</div>;
  }
  return (
    <div className="hero">
      <div className="tag"><span className="dot" /><span className="label">THE ONE THING</span></div>
      {inner}
    </div>
  );
}

export function Brief({ today, onResolve }: { today: Today; onResolve: (id: number, value: string) => void }): React.ReactElement {
  const totalOpen = today.counts.openTasks + today.counts.followups + today.counts.questions;

  if (totalOpen === 0) {
    return (
      <section className="brief">
        <div className="all-clear">
          <div className="halo"><div className="ring" /><div className="core" /></div>
          <h2>You&apos;re clear.</h2>
          <p>Nothing open today. Peek at recents if you&apos;re curious.</p>
        </div>
      </section>
    );
  }

  const hero = today.hero;
  const heroQId = hero?.kind === "question" ? (hero.item as TodayQuestion).id : null;
  const heroTaskText = hero?.kind === "task" ? (hero.item as TodayItem).text : null;

  // De-duplicate the hero from the lists below it.
  let taskDropped = false;
  const openTasks = today.openTasks.filter((t) => {
    if (!taskDropped && heroTaskText !== null && t.text === heroTaskText) { taskDropped = true; return false; }
    return true;
  });
  const questions = today.questions.filter((q) => q.id !== heroQId);

  const haveTasks = today.counts.openTasks > 0 || today.counts.followups > 0;
  const subline = haveTasks ? `today · ${totalOpen} open` : `today · ${totalOpen} to decide`;

  return (
    <section className="brief">
      <div className="subline">{subline}</div>
      {today.brief !== null ? <p className="brief-text">{today.brief.text}</p> : null}

      {hero !== null ? <HeroCard hero={hero} onResolve={onResolve} /> : null}

      {openTasks.length > 0 ? (
        <div className="section">
          <div className="label">Open tasks</div>
          <div className="rows">{openTasks.map((t, i) => <TaskRow key={`t${i}`} item={t} />)}</div>
        </div>
      ) : null}

      {today.followups.length > 0 ? (
        <div className="section">
          <div className="label">Follow-ups</div>
          <div className="rows">{today.followups.map((t, i) => <TaskRow key={`f${i}`} item={t} followup />)}</div>
        </div>
      ) : null}

      {questions.length > 0 ? (
        <div className="section">
          {questions.map((q) => <QuestionCard key={q.id} q={q} onResolve={onResolve} />)}
        </div>
      ) : null}
    </section>
  );
}
