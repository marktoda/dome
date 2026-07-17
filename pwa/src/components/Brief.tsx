import { useRef, useState } from "react";
import {
  buildTodayViewModel,
  parseTodayView,
  priorityMarkerChars,
  type TodayTaskRow,
  type TodayQuestionRow,
  type TodayReviewRow,
} from "../../../src/surface/today-view";
import type { Today } from "../api/types";
import { renderRich } from "../rich";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const AGENDA_CAP = 5;

/** "2026-06-20" → "Jun 20". Deterministic (no Date / timezone). */
function fmtDue(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m === null) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? ""} ${Number(m[3])}`;
}

/** Priority marker glyph, shared with the CLI/HTTP surfaces via the view-model. */
function PriorityMark({ priority }: { priority: TodayTaskRow["priority"] }): React.ReactElement | null {
  const chars = priorityMarkerChars(priority, true);
  if (chars.length === 0) return null;
  const high = priority === "highest" || priority === "high";
  const label = priority === "highest" ? "Highest" : priority === "high" ? "High" : priority === "low" ? "Low" : "Lowest";
  return <><span className={`prio ${high ? "prio-high" : "prio-low"}`} aria-hidden="true">{chars} </span><span className="sr-only">{label} priority. </span></>;
}

function TaskRow(
  { item, settlement, onSettle, interactive }: {
    item: TodayTaskRow;
    settlement: "pending" | "success" | "failure" | null;
    onSettle: (item: TodayTaskRow) => void;
    interactive: boolean;
  },
): React.ReactElement {
  const blockId = item.blockId;
  const settling = settlement === "pending";
  const settled = settlement === "success";
  const statusId = blockId === undefined ? undefined : `settlement-${blockId}`;
  return (
    <div className={`row${settling || settled ? " settling" : ""}${settlement === "failure" ? " settle-failed" : ""}`}>
      {blockId !== undefined ? (
        <label className="task-hit">
          <input
            type="checkbox"
            className="box"
            checked={settling || settled}
            disabled={settlement !== null || !interactive}
            aria-label={item.text}
            aria-describedby={settlement === null ? undefined : statusId}
            onChange={() => onSettle(item)}
          />
        </label>
      ) : (
        // No blockId (not yet anchored) — decorative-only. Completing a task
        // here means a git commit; without a stable ^block-anchor there's no
        // settle identity to write to, so the box stays inert.
        <span className="task-hit" aria-hidden="true"><span className="box" /></span>
      )}
      <div className="text">
        <span className="task-copy"><PriorityMark priority={item.priority} />{renderRich(item.text)}</span>
        {settlement === "pending" ? <div id={statusId} className="task-settle-state">Saving…</div> : null}
        {settlement === "success" ? <div id={statusId} className="task-settle-state task-settle-success">Completed</div> : null}
        {settlement === "failure" ? (
          <div id={statusId} className="task-settle-state task-settle-failure" role="alert">
            Completion was not saved.
            <button type="button" onClick={() => onSettle(item)}>Retry</button>
          </div>
        ) : null}
      </div>
      {item.dueDate !== null ? <span className="due">{fmtDue(item.dueDate)}</span> : null}
    </div>
  );
}

function QuestionCard({ q, onResolve, interactive }: { q: TodayQuestionRow; onResolve: (id: number, value: string) => void; interactive: boolean }): React.ReactElement {
  const titleId = `question-${q.id}`;
  return (
    <section className="qcard" aria-labelledby={titleId}>
      <div id={titleId} className="body">{renderRich(q.question)}</div>
      <div className="opts">
        {q.options.map((opt) => <button key={opt} type="button" disabled={!interactive} onClick={() => onResolve(q.id, opt)}>{opt}</button>)}
      </div>
    </section>
  );
}

function ReviewCard({ review }: { review: TodayReviewRow }): React.ReactElement {
  return (
    <section className="qcard review-card" aria-label="Review needed">
      <div className="body">{renderRich(review.reason)}</div>
      {review.paths.length > 0 ? <div className="review-evidence">Evidence: {review.paths.join(", ")}</div> : null}
      <div className="review-action">On your Mac, run <code>{review.reviewCommand}</code></div>
    </section>
  );
}

/** One urgency bucket (overdue / today / this week / later) — header + rows; nothing when empty. */
function Bucket(
  { label, cls, items, settlements, onSettle, interactive }: {
    label: string;
    cls: string;
    items: ReadonlyArray<TodayTaskRow>;
    settlements: ReadonlyMap<string, "pending" | "success" | "failure">;
    onSettle: (item: TodayTaskRow) => void;
    interactive: boolean;
  },
): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <>
      <div className={`bucket-label ${cls}`}>{label} · {items.length}</div>
      <div className="rows">
        {items.map((t, i) => (
          <TaskRow
            key={`${cls}${i}`}
            item={t}
            settlement={t.blockId === undefined ? null : settlements.get(t.blockId) ?? null}
            onSettle={onSettle}
            interactive={interactive}
          />
        ))}
      </div>
    </>
  );
}

type Props = {
  today: Today;
  onResolve: (id: number, value: string) => void;
  /** Settle a task closed by its ^block-anchor id; resolves to whether it
   * actually settled — the caller owns the API call, this component owns
   * only the optimistic strike-through + revert-on-failure UI state. */
  onSettle?: (blockId: string) => Promise<boolean>;
  collapsed?: boolean;
  hasMessages?: boolean;
  onToggle?: () => void;
  interactive?: boolean;
  onReviewBacklog?: () => void;
};

export function Brief(
  { today, onResolve, onSettle = async () => false, collapsed = false, hasMessages = false, onToggle = () => {}, interactive = true, onReviewBacklog }: Props,
): React.ReactElement | null {
  const [showAll, setShowAll] = useState(false);
  const [showAgedBacklog, setShowAgedBacklog] = useState(false);
  const [settlements, setSettlements] = useState<ReadonlyMap<string, "pending" | "success" | "failure">>(new Map());
  const [settlementNotice, setSettlementNotice] = useState<string | null>(null);
  const settlementInFlight = useRef(new Set<string>());

  const handleSettle = (item: TodayTaskRow): void => {
    const blockId = item.blockId;
    if (blockId === undefined || settlementInFlight.current.has(blockId) || settlements.get(blockId) === "success") return;
    settlementInFlight.current.add(blockId);
    setSettlements((current) => new Map(current).set(blockId, "pending"));
    setSettlementNotice(null);
    void onSettle(blockId).then((ok) => {
      setSettlements((current) => new Map(current).set(blockId, ok ? "success" : "failure"));
      if (ok) setSettlementNotice(`Completed “${item.text}”.`);
    }).catch(() => {
      setSettlements((current) => new Map(current).set(blockId, "failure"));
    }).finally(() => {
      settlementInFlight.current.delete(blockId);
    });
  };

  // Paint the SHARED view-model — same urgency classification, sections, and
  // counts the CLI and HTTP cockpit render (src/surface/today-view.ts). The PWA
  // no longer re-derives "is this overdue" or carries a bespoke hero.
  const vm = buildTodayViewModel(parseTodayView(today));
  const {
    brief,
    calendar,
    questions,
    reviews,
    attentionBacklog,
    stillOpen,
    agedBacklog,
    omittedOpenCount,
    counts,
    totalOpen,
  } = vm;

  if (totalOpen === 0) {
    if (hasMessages) return null;
    return (
      <section className="brief">
        {settlementNotice !== null ? <p className="task-settle-announcement" role="status" aria-live="polite">{settlementNotice}</p> : null}
        <div className="all-clear">
          <div className="halo"><div className="ring" /><div className="core" /></div>
          <h2>You&apos;re clear.</h2>
          <p>Nothing open today. Ask your brain anything, or capture a thought below.</p>
        </div>
      </section>
    );
  }

  // Followups are a facet of openTasks, not a second logical-task collection.
  const openCount = counts.openTasks;
  const focusOpenCount = stillOpen.overdue.length + stillOpen.dueToday.length +
    stillOpen.thisWeek.length + stillOpen.later.length + stillOpen.someday.length;
  const hasDeferredDebt = agedBacklog.length > 0 || omittedOpenCount > 0;
  const openSummary = openCount === 0
    ? null
    : hasDeferredDebt && focusOpenCount > 0
      ? `${focusOpenCount} in focus · ${openCount} open total`
      : `${openCount} open${hasDeferredDebt ? " total" : ""}`;
  const qCount = counts.questions;
  const reviewCount = counts.reviews ?? reviews.length;
  const ownerBacklog = attentionBacklog + reviewCount;
  const summary =
    [
      openSummary,
      qCount > 0 ? `${qCount} to decide` : null,
      ownerBacklog > 0 ? `${ownerBacklog} need attention` : null,
    ]
      .filter(Boolean).join(" · ") || "all clear";

  if (collapsed) {
    return (
      <>
        {settlementNotice !== null ? <p className="task-settle-announcement" role="status" aria-live="polite">{settlementNotice}</p> : null}
        <button type="button" className="brief-bar" onClick={onToggle}>
          <span className="left"><span className="dot" />Today&apos;s brief</span>
          <span className="sum">{summary} ▾</span>
        </button>
      </>
    );
  }

  // Urgent buckets shown inline; later + someday fold into a "+N more, later"
  // reveal — the HTTP cockpit's treatment, painted from the same view-model.
  const { overdue, dueToday, thisWeek, later, someday } = stillOpen;
  const laterAll = [...later, ...someday];
  const shownInline = overdue.length + dueToday.length + thisWeek.length;
  const hidden = laterAll.length;
  const agendaEvents = calendar !== null ? calendar.events.slice(0, AGENDA_CAP) : [];
  const agendaMore = calendar !== null ? calendar.events.length - agendaEvents.length : 0;

  return (
    <section className="brief">
      {settlementNotice !== null ? <p className="task-settle-announcement" role="status" aria-live="polite">{settlementNotice}</p> : null}
      <div className="brief-head">
        <span className="label">today · {summary}</span>
        {hasMessages ? <button type="button" className="hide" onClick={onToggle}>hide ▴</button> : null}
      </div>

      {brief !== null ? <p className="brief-text">{renderRich(brief.text)}</p> : null}

      {agendaEvents.length > 0 ? (
        <div className="section agenda">
          <div className="label">Agenda</div>
          {agendaEvents.map((ev, i) => (
            <div className="agenda-row" key={`ev${i}`}>
              <span className="agenda-time">{ev.time === "" ? "—" : ev.time}</span>
              <span className="agenda-body">
                {ev.title}
                {ev.meta.length > 0 ? <span className="agenda-meta"> · {ev.meta}</span> : null}
              </span>
            </div>
          ))}
          {agendaMore > 0 ? <div className="agenda-more">+{agendaMore} more</div> : null}
        </div>
      ) : null}

      {shownInline > 0 || laterAll.length > 0 || agedBacklog.length > 0 || omittedOpenCount > 0 ? (
        <div className="section">
          <div className="label">Still open</div>
          <Bucket label="overdue" cls="bucket-overdue" items={overdue} settlements={settlements} onSettle={handleSettle} interactive={interactive} />
          <Bucket label="today" cls="bucket-today" items={dueToday} settlements={settlements} onSettle={handleSettle} interactive={interactive} />
          <Bucket label="this week" cls="bucket-week" items={thisWeek} settlements={settlements} onSettle={handleSettle} interactive={interactive} />
          {showAll ? <Bucket label="later" cls="bucket-later" items={laterAll} settlements={settlements} onSettle={handleSettle} interactive={interactive} /> : null}
          {!showAll && hidden > 0 ? (
            <button type="button" className="brief-more" onClick={() => setShowAll(true)}>+{hidden} more, later ▾</button>
          ) : null}
          {showAll && hidden > 0 ? (
            <button type="button" className="brief-more" onClick={() => setShowAll(false)}>show less ▴</button>
          ) : null}
          {agedBacklog.length > 0 ? (
            <>
              <button
                type="button"
                className="brief-more"
                aria-expanded={showAgedBacklog}
                onClick={() => setShowAgedBacklog((shown) => !shown)}
              >
                {agedBacklog.length} older backlog {agedBacklog.length === 1 ? "item" : "items"} · 30+ days overdue {showAgedBacklog ? "▴" : "▾"}
              </button>
              {showAgedBacklog ? (
                <Bucket
                  label="older backlog · 30+ days overdue"
                  cls="bucket-overdue"
                  items={agedBacklog}
                  settlements={settlements}
                  onSettle={handleSettle}
                  interactive={interactive}
                />
              ) : null}
            </>
          ) : null}
          {omittedOpenCount > 0 ? (
            <div className="brief-more">{omittedOpenCount} additional open {omittedOpenCount === 1 ? "item" : "items"} omitted from this view</div>
          ) : null}
          {openCount > 0 && onReviewBacklog !== undefined ? (
            <button type="button" className="review-backlog-entry" onClick={onReviewBacklog}>
              Review backlog · {openCount} open {openCount === 1 ? "commitment" : "commitments"}
            </button>
          ) : null}
        </div>
      ) : null}

      {questions.length > 0 ? (
        <div className="section">
          <div className="label">To decide</div>
          <div className="rows">{questions.map((q) => <QuestionCard key={q.id} q={q} onResolve={onResolve} interactive={interactive} />)}</div>
        </div>
      ) : null}
      {reviews.length > 0 ? (
        <div className="section">
          <div className="label">Needs review</div>
          <div className="rows">{reviews.map((review) => <ReviewCard key={review.id} review={review} />)}</div>
        </div>
      ) : null}
      {attentionBacklog > 0 ? (
        <div className="brief-more review-backlog-action">
          {attentionBacklog} more {attentionBacklog === 1 ? "item needs" : "items need"} attention. On your Mac, run <code>dome check --decisions</code>.
        </div>
      ) : null}
    </section>
  );
}
