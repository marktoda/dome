import { useState } from "react";
import type { Today, TodayItem, TodayQuestion } from "../api/types";
import { renderRich } from "../rich";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CAP = 5; // glanceable by default; "+N more" reveals the rest

/** "2026-06-20" → "Jun 20". Deterministic (no Date / timezone). */
function fmtDue(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m === null) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? ""} ${Number(m[3])}`;
}

function TaskRow({ item, followup = false }: { item: TodayItem; followup?: boolean }): React.ReactElement {
  return (
    <div className={`row${followup ? " followup" : ""}`}>
      {/* Non-interactive for now: completing a task = editing markdown = a git commit,
          which needs a co-located checkout the phone lacks. Make this a checkable
          control once there's a phone write-path (the deferred authoring boundary). */}
      <div className="box" />
      <div className="text">{renderRich(item.text)}</div>
      {item.dueDate !== null ? <span className="due">{fmtDue(item.dueDate)}</span> : null}
    </div>
  );
}

function QuestionCard({ q, onResolve }: { q: TodayQuestion; onResolve: (id: number, value: string) => void }): React.ReactElement {
  return (
    <div className="qcard">
      <div className="body">{renderRich(q.question)}</div>
      <div className="opts">
        {q.options.map((opt) => <button key={opt} type="button" onClick={() => onResolve(q.id, opt)}>{opt}</button>)}
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
        <div className="body">{renderRich(q.question)}</div>
        <div className="opts">{q.options.map((opt) => <button key={opt} type="button" onClick={() => onResolve(q.id, opt)}>{opt}</button>)}</div>
      </>
    );
  } else {
    const t = hero.item as TodayItem;
    inner = <div className="body">{renderRich(t.text)}{t.dueDate !== null ? <span className="due">{fmtDue(t.dueDate)}</span> : null}</div>;
  }
  return (
    <div className="hero">
      <div className="tag"><span className="dot" /><span className="label">THE ONE THING</span></div>
      {inner}
    </div>
  );
}

type Props = {
  today: Today;
  onResolve: (id: number, value: string) => void;
  collapsed?: boolean;
  hasMessages?: boolean;
  onToggle?: () => void;
};

export function Brief({ today, onResolve, collapsed = false, hasMessages = false, onToggle = () => {} }: Props): React.ReactElement | null {
  const [showAll, setShowAll] = useState(false);

  const hero = today.hero;
  const heroQId = hero !== null && hero.kind === "question" ? (hero.item as TodayQuestion).id : null;
  const heroTaskText = hero !== null && hero.kind === "task" ? (hero.item as TodayItem).text : null;

  // De-duplicate the hero from the lists below it.
  let taskDropped = false;
  const openTasks = today.openTasks.filter((t) => {
    if (!taskDropped && heroTaskText !== null && t.text === heroTaskText) { taskDropped = true; return false; }
    return true;
  });
  const questions = today.questions.filter((q) => q.id !== heroQId);

  const openCount = openTasks.length + (hero?.kind === "task" ? 1 : 0);
  const qCount = questions.length + (heroQId !== null ? 1 : 0);
  const totalOpen = openCount + today.followups.length + qCount;

  if (totalOpen === 0) {
    if (hasMessages) return null;
    return (
      <section className="brief">
        <div className="all-clear">
          <div className="halo"><div className="ring" /><div className="core" /></div>
          <h2>You&apos;re clear.</h2>
          <p>Nothing open today. Ask your brain anything, or capture a thought below.</p>
        </div>
      </section>
    );
  }

  const summary =
    [openCount > 0 ? `${openCount} open` : null, qCount > 0 ? `${qCount} to decide` : null]
      .filter(Boolean).join(" · ") || "all clear";

  if (collapsed) {
    return (
      <button type="button" className="brief-bar" onClick={onToggle}>
        <span className="left"><span className="dot" />Today&apos;s brief</span>
        <span className="sum">{summary} ▾</span>
      </button>
    );
  }

  const tasksShown = showAll ? openTasks : openTasks.slice(0, CAP);
  const fupsShown = showAll ? today.followups : today.followups.slice(0, CAP);
  const qsShown = showAll ? questions : questions.slice(0, CAP);
  const hidden =
    (openTasks.length - tasksShown.length) +
    (today.followups.length - fupsShown.length) +
    (questions.length - qsShown.length);

  return (
    <section className="brief">
      <div className="brief-head">
        <span className="label">today · {summary}</span>
        {hasMessages ? <button type="button" className="hide" onClick={onToggle}>hide ▴</button> : null}
      </div>
      {today.brief !== null ? <p className="brief-text">{renderRich(today.brief.text)}</p> : null}
      {hero !== null ? <HeroCard hero={hero} onResolve={onResolve} /> : null}

      {tasksShown.length > 0 ? (
        <div className="section">
          <div className="label">Open tasks</div>
          <div className="rows">{tasksShown.map((t, i) => <TaskRow key={`t${i}`} item={t} />)}</div>
        </div>
      ) : null}

      {fupsShown.length > 0 ? (
        <div className="section">
          <div className="label">Follow-ups</div>
          <div className="rows">{fupsShown.map((t, i) => <TaskRow key={`f${i}`} item={t} followup />)}</div>
        </div>
      ) : null}

      {qsShown.length > 0 ? (
        <div className="section">
          <div className="label">To decide</div>
          <div className="rows">{qsShown.map((q) => <QuestionCard key={q.id} q={q} onResolve={onResolve} />)}</div>
        </div>
      ) : null}

      {hidden > 0 ? <button type="button" className="brief-more" onClick={() => setShowAll(true)}>+{hidden} more ▾</button> : null}
      {showAll && totalOpen > CAP ? <button type="button" className="brief-more" onClick={() => setShowAll(false)}>show less ▴</button> : null}
    </section>
  );
}
