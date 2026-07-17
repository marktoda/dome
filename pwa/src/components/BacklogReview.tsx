import { useCallback, useEffect, useRef, useState } from "react";
import type { DomeClient } from "../api/client";
import type {
  TaskBacklog,
  TaskBacklogReviewRequest,
  TaskBacklogReviewResult,
} from "../api/types";
import type { TaskBacklogUnit } from "../../../contracts/task-backlog";
import { TASK_BACKLOG_REVIEW_SCHEMA } from "../../../contracts/task-backlog-review";
import { useModalFocus } from "../accessibility/modalFocus";
import { SourceViewer } from "./SourceViewer";

const PAGE_SIZE = 25;

type BacklogPage = Extract<TaskBacklog, { readonly status: "ok" }>;
type BacklogMember = TaskBacklogUnit["members"][number];
type Disposition = "keep" | "defer" | "close";
type SelectedDecision = {
  readonly member: BacklogMember;
  readonly disposition: Disposition;
  readonly deferUntil: string;
};
type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "error"; readonly message: string };
type SubmitProblem = {
  readonly kind: "conflict" | "busy" | "invalid" | "unknown";
  readonly message: string;
};

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function deferProblem(decision: SelectedDecision, reviewDate: string): string | null {
  if (decision.disposition !== "defer") return null;
  if (!isCalendarDate(decision.deferUntil)) return "Choose a valid defer date.";
  if (decision.deferUntil < reviewDate) return `Choose ${reviewDate} or later.`;
  return null;
}

function shortDate(iso: string | null): string | null {
  if (iso === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return iso;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function unreviewableReason(member: BacklogMember): string {
  return member.blockId === undefined
    ? "This task has no stable anchor yet. Open its source and let Dome stamp an anchor before reviewing it."
    : `The anchor ^${member.blockId} appears more than once. Open the source and repair the duplicate anchor before reviewing it.`;
}

function sourceLabel(member: BacklogMember): string {
  const context = member.sourceContext;
  const title = context.title?.trim();
  const path = title !== undefined && title.length > 0 ? `${title} · ${context.path}` : context.path;
  return context.line === null ? path : `${path}:${context.line}`;
}

function countDecisions(decisions: ReadonlyMap<string, SelectedDecision>): Record<Disposition, number> {
  const counts = { keep: 0, defer: 0, close: 0 };
  for (const decision of decisions.values()) counts[decision.disposition] += 1;
  return counts;
}

function matchingSourceRef(member: BacklogMember): BacklogMember["sourceRefs"][number] {
  return member.sourceRefs.find((ref) =>
    ref.path === member.sourceContext.path &&
    (member.sourceContext.line === null ||
      (ref.range.startLine <= member.sourceContext.line && ref.range.endLine >= member.sourceContext.line))
  ) ?? member.sourceRefs[0]!;
}

export function compileBacklogReviewRequest(
  revision: string,
  decisions: ReadonlyMap<string, SelectedDecision>,
): TaskBacklogReviewRequest {
  return {
    schema: TASK_BACKLOG_REVIEW_SCHEMA,
    revision,
    decisions: [...decisions.values()].map((decision) => {
      const sourceRef = matchingSourceRef(decision.member);
      return decision.disposition === "defer"
        ? {
            blockId: decision.member.blockId!,
            disposition: "defer",
            deferUntil: decision.deferUntil,
            sourceRef,
          }
        : {
            blockId: decision.member.blockId!,
            disposition: decision.disposition,
            sourceRef,
          };
    }),
  };
}

function Confirmation({
  decisions,
  submitting,
  onCancel,
  onConfirm,
  returnFocus,
  interactive,
}: {
  readonly decisions: ReadonlyMap<string, SelectedDecision>;
  readonly submitting: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly returnFocus: HTMLElement | null;
  readonly interactive: boolean;
}): React.ReactElement {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const counts = countDecisions(decisions);
  useModalFocus({
    active: true,
    focusKey: "backlog-confirmation",
    containerRef: dialogRef,
    initialFocus: () => cancelRef.current,
    onEscape: submitting ? () => {} : onCancel,
    restoreFocus: () => returnFocus,
  });
  return (
    <div className="backlog-confirm-backdrop">
      <section
        ref={dialogRef}
        className="backlog-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="backlog-confirm-title"
        aria-describedby="backlog-confirm-summary"
        tabIndex={-1}
      >
        <h2 id="backlog-confirm-title">Apply reviewed decisions?</h2>
        <p id="backlog-confirm-summary">
          {counts.keep} leave open · {counts.defer} defer · {counts.close} close
        </p>
        {counts.close > 0 ? <p>Closing marks those source tasks complete and records them in Done today.</p> : null}
        {counts.defer > 0 ? <p>Deferring changes the due date on those source tasks.</p> : null}
        {counts.keep > 0 ? <p>Leave open is explicit, makes no Markdown change, and can reappear in later reviews.</p> : null}
        <div className="backlog-confirm-actions">
          <button ref={cancelRef} type="button" disabled={submitting} onClick={onCancel}>Cancel</button>
          <button type="button" disabled={submitting || !interactive} onClick={onConfirm}>
            {submitting ? "Applying…" : `Apply ${decisions.size} selected`}
          </button>
        </div>
      </section>
    </div>
  );
}

function MemberRow({
  member,
  reviewDate,
  decision,
  interactive,
  readable,
  reviewable,
  reviewProblem,
  onDecision,
  onOpenSource,
}: {
  readonly member: BacklogMember;
  readonly reviewDate: string;
  readonly decision: SelectedDecision | undefined;
  readonly interactive: boolean;
  readonly readable: boolean;
  readonly reviewable: boolean;
  readonly reviewProblem?: string | undefined;
  readonly onDecision: (member: BacklogMember, disposition: Disposition, deferUntil?: string) => void;
  readonly onOpenSource: (member: BacklogMember, trigger: HTMLButtonElement) => void;
}): React.ReactElement {
  const rowReviewable = interactive && reviewable;
  const groupName = `backlog-decision-${member.id}`;
  const problem = decision === undefined ? null : deferProblem(decision, reviewDate);
  return (
    <li className={`backlog-member${reviewable ? "" : " unreviewable"}`}>
      <div className="backlog-source-context">
        <button
          type="button"
          className="backlog-source-open"
          disabled={!readable}
          onClick={(event) => onOpenSource(member, event.currentTarget)}
        >
          {sourceLabel(member)}
        </button>
        <span>
          {member.dueDate === null ? "No due date" : `Due ${member.dueDate}`}
          {member.lastChangedAt === null ? "" : ` · changed ${shortDate(member.lastChangedAt)}`}
        </span>
      </div>
      {!reviewable ? <p className="backlog-unreviewable" role="note">{reviewProblem ?? unreviewableReason(member)}</p> : null}
      <fieldset className="backlog-dispositions" disabled={!rowReviewable}>
        <legend className="sr-only">Decision for {sourceLabel(member)}</legend>
        {(["keep", "defer", "close"] as const).map((disposition) => (
          <label key={disposition}>
            <input
              type="radio"
              name={groupName}
              value={disposition}
              checked={decision?.disposition === disposition}
              onChange={() => onDecision(member, disposition)}
            />
            <span>{disposition === "keep" ? "Leave open" : disposition[0]!.toUpperCase() + disposition.slice(1)}</span>
          </label>
        ))}
      </fieldset>
      {decision?.disposition === "defer" ? (
        <label className="backlog-defer-date">
          Defer until
          <input
            type="date"
            min={reviewDate}
            value={decision.deferUntil}
            aria-invalid={problem !== null}
            aria-describedby={problem === null ? undefined : `defer-error-${member.id}`}
            disabled={!rowReviewable}
            onChange={(event) => onDecision(member, "defer", event.currentTarget.value)}
          />
          {problem !== null ? <span id={`defer-error-${member.id}`} role="alert">{problem}</span> : null}
        </label>
      ) : null}
    </li>
  );
}

function ReviewUnit({
  unit,
  reviewDate,
  decisions,
  interactive,
  readable,
  onDecision,
  onOpenSource,
}: {
  readonly unit: TaskBacklogUnit;
  readonly reviewDate: string;
  readonly decisions: ReadonlyMap<string, SelectedDecision>;
  readonly interactive: boolean;
  readonly readable: boolean;
  readonly onDecision: (member: BacklogMember, disposition: Disposition, deferUntil?: string) => void;
  readonly onOpenSource: (member: BacklogMember, trigger: HTMLButtonElement) => void;
}): React.ReactElement {
  const timing = unit.classification.timing === "overdue"
    ? "Overdue"
    : unit.classification.timing === "dated"
      ? "Dated"
      : "Undated";
  return (
    <article className="backlog-unit" aria-labelledby={`backlog-unit-${unit.id}`}>
      <div className="backlog-unit-head">
        <div className="backlog-tags">
          <span className={`backlog-tag ${unit.classification.timing}`}>{timing}</span>
          {unit.classification.exactDuplicateCandidate
            ? <span className="backlog-tag duplicate">Exact duplicate candidate · {unit.members.length} commitments</span>
            : null}
        </div>
        <h3 id={`backlog-unit-${unit.id}`}>{unit.text}</h3>
      </div>
      <ul className="backlog-members">
        {unit.members.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            reviewDate={reviewDate}
            decision={decisions.get(member.id)}
            interactive={interactive}
            readable={readable}
            reviewable={unit.reviewable && member.reviewable}
            reviewProblem={!unit.reviewable && member.reviewable
              ? "One exact-text match in this group has ambiguous identity. Repair that source before reviewing any member in the group."
              : undefined}
            onDecision={(selected, disposition, deferUntil) => onDecision(selected, disposition, deferUntil)}
            onOpenSource={onOpenSource}
          />
        ))}
      </ul>
    </article>
  );
}

export function BacklogReview({
  client,
  interactive,
  readable = true,
  onReviewed,
}: {
  readonly client: DomeClient;
  readonly interactive: boolean;
  readonly readable?: boolean;
  readonly onReviewed: () => void;
}): React.ReactElement {
  const [pages, setPages] = useState<ReadonlyArray<BacklogPage>>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<ReadonlyMap<string, SelectedDecision>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitProblem, setSubmitProblem] = useState<SubmitProblem | null>(null);
  const [retryRequest, setRetryRequest] = useState<TaskBacklogReviewRequest | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ member: BacklogMember; trigger: HTMLButtonElement } | null>(null);
  const loadSequence = useRef(0);
  const submitInFlight = useRef(false);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const current = pages[pageIndex];

  const loadFirst = useCallback((message?: string): void => {
    const sequence = ++loadSequence.current;
    setLoadState({ kind: "loading" });
    setNotice(message ?? null);
    setPages([]);
    setPageIndex(0);
    setDecisions(new Map());
    setConfirming(false);
    setSubmitProblem(null);
    setRetryRequest(null);
    void client.taskBacklog({ limit: PAGE_SIZE }).then((result) => {
      if (sequence !== loadSequence.current) return;
      if (result.status === "error") {
        setLoadState({ kind: "error", message: result.message });
        return;
      }
      setPages([result]);
      setLoadState({ kind: "ready" });
    }, () => {
      if (sequence === loadSequence.current) {
        setLoadState({ kind: "error", message: "Backlog review could not be loaded. Check Connection and try again." });
      }
    });
  }, [client]);

  useEffect(() => {
    loadFirst();
    return () => { loadSequence.current += 1; };
  }, [loadFirst]);

  const nextPage = (): void => {
    if (current === undefined || current.page.nextCursor === null || decisions.size > 0) return;
    if (pages[pageIndex + 1] !== undefined) {
      setPageIndex(pageIndex + 1);
      return;
    }
    const sequence = ++loadSequence.current;
    setLoadState({ kind: "loading" });
    void client.taskBacklog({ limit: PAGE_SIZE, cursor: current.page.nextCursor }).then((result) => {
      if (sequence !== loadSequence.current) return;
      if (result.status === "error") {
        loadFirst("The adopted backlog changed while you were paging. Review restarted from page 1; no decisions were submitted.");
        return;
      }
      setPages((loaded) => [...loaded, result]);
      setPageIndex(pageIndex + 1);
      setLoadState({ kind: "ready" });
    }, () => {
      if (sequence === loadSequence.current) {
        setLoadState({ kind: "error", message: "The next backlog page could not be loaded. Your selections are still here; try the page again." });
      }
    });
  };

  const choose = (member: BacklogMember, disposition: Disposition, deferUntil?: string): void => {
    if (!member.reviewable || member.blockId === undefined) return;
    if (!decisions.has(member.id) && decisions.size >= 100) {
      setNotice("A review batch can contain at most 100 commitments. Apply or clear this batch before selecting more.");
      return;
    }
    setReceipt(null);
    setSubmitProblem(null);
    setDecisions((selected) => {
      const next = new Map(selected);
      const prior = next.get(member.id);
      next.set(member.id, {
        member,
        disposition,
        deferUntil: disposition === "defer" ? deferUntil ?? prior?.deferUntil ?? "" : "",
      });
      return next;
    });
  };

  const refreshAfterUncertain = (message: string): void => {
    setReceipt(null);
    loadFirst(message);
  };

  const submitRequest = (request: TaskBacklogReviewRequest): void => {
    if (!interactive || submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    setSubmitProblem(null);
    setRetryRequest(request);
    void client.reviewTaskBacklog(request).then((result) => {
      if (result.status === "settled") {
        const counts = countDecisions(decisions);
        const commit = result.commit === null
          ? counts.close + counts.defer === 0
            ? "Left open; nothing was committed."
            : "The changes were already applied; no new commit was needed."
          : result.adoptionStatus === "pending"
            ? `Committed ${result.commit.slice(0, 8)}; awaiting adoption.`
            : `Committed ${result.commit.slice(0, 8)}.`;
        setReceipt(`Reviewed ${request.decisions.length} selected ${request.decisions.length === 1 ? "commitment" : "commitments"}. ${commit}`);
        submitInFlight.current = false;
        setSubmitting(false);
        setConfirming(false);
        setRetryRequest(null);
        onReviewed();
        loadFirst(counts.close + counts.defer === 0
          ? "Leave-open choices are not stored. Page 1 reloaded; those commitments remain open and may appear again."
          : "Review completed. Page 1 reloaded; committed changes may remain visible until adoption finishes.");
        return;
      }
      submitInFlight.current = false;
      setSubmitting(false);
      setConfirming(false);
      handleReviewProblem(result);
    }, () => {
      submitInFlight.current = false;
      setSubmitting(false);
      setConfirming(false);
      setSubmitProblem({
        kind: "unknown",
        message: "Home did not return a review receipt. Do not submit again yet; refresh the backlog to reconcile what happened.",
      });
    });
  };

  const submit = (): void => {
    if (!interactive || current === undefined || decisions.size === 0 || submitting) return;
    const invalid = [...decisions.values()].find((decision) => deferProblem(decision, current.date) !== null);
    if (invalid !== undefined) {
      setConfirming(false);
      setNotice("Fix the highlighted defer date before applying this review.");
      return;
    }
    submitRequest(compileBacklogReviewRequest(current.revision, decisions));
  };

  const handleReviewProblem = (result: Extract<TaskBacklogReviewResult, { status: "error" }>): void => {
    if (result.error === "stale-review") {
      loadFirst("The adopted backlog changed before your review landed. Review restarted from page 1; the stale decisions were not applied.");
      return;
    }
    if (result.error === "busy") {
      setSubmitProblem({ kind: "busy", message: `${result.message} Your selections are preserved and are safe to retry.` });
      return;
    }
    if (result.error === "outcome-unknown") {
      setSubmitProblem({ kind: "unknown", message: `${result.message} Do not submit again until you refresh the backlog and reconcile the result.` });
      return;
    }
    if (result.error === "invalid-request") {
      setSubmitProblem({
        kind: "invalid",
        message: `${result.message} Refresh the backlog. If this repeats, update Dome Home and this PWA together, then check Connection.`,
      });
      setDecisions(new Map());
      setRetryRequest(null);
      return;
    }
    setSubmitProblem({
      kind: "conflict",
      message: `${result.message} Refresh the backlog; if it repeats, open the affected sources and repair them on your Mac.`,
    });
    setDecisions(new Map());
    setRetryRequest(null);
  };

  const canConfirm = current !== undefined && decisions.size > 0 &&
    [...decisions.values()].every((decision) => deferProblem(decision, current.date) === null);

  return (
    <div className="backlog-review">
      <header className="backlog-review-intro">
        <h2>Review open commitments</h2>
        <p>Choose only what you have decided. Nothing is selected or inferred for you.</p>
      </header>
      {notice !== null ? <p className="backlog-notice" role="status" aria-live="polite">{notice}</p> : null}
      {receipt !== null ? <p className="backlog-receipt" role="status" aria-live="polite">{receipt}</p> : null}
      {submitProblem !== null ? (
        <section className={`backlog-problem ${submitProblem.kind}`} role="alert">
          <strong>{submitProblem.kind === "busy" ? "Home is busy" : submitProblem.kind === "conflict" ? "Source conflict" : submitProblem.kind === "invalid" ? "Review request incompatible" : "Outcome needs reconciliation"}</strong>
          <p>{submitProblem.message}</p>
          {submitProblem.kind === "busy"
            ? <div className="backlog-problem-actions">
                <button type="button" disabled={retryRequest === null || !interactive} onClick={() => { if (retryRequest !== null) submitRequest(retryRequest); }}>Retry same batch</button>
                <button type="button" onClick={() => refreshAfterUncertain("The busy review was discarded. Recheck every decision before submitting.")}>Discard and refresh</button>
              </div>
            : <button type="button" onClick={() => refreshAfterUncertain("Backlog refreshed after the previous review problem. Recheck every decision before submitting.")}>Refresh backlog</button>}
        </section>
      ) : null}
      {loadState.kind === "error" ? (
        <section className="backlog-problem unknown" role="alert">
          <strong>Backlog unavailable</strong>
          <p>{loadState.message}</p>
          <button type="button" onClick={() => current === undefined ? loadFirst() : nextPage()}>Try again</button>
        </section>
      ) : null}
      {current !== undefined ? (
        <>
          <div className="backlog-overview" aria-label="Backlog summary">
            <span>{current.page.total} review units</span>
            <span>{current.page.commitments} commitments</span>
            <span>{current.groups.exactDuplicateCandidates} exact duplicate candidates</span>
          </div>
          <div className="backlog-page-status">
            <span>Page {pageIndex + 1} · {current.items.length} of {current.page.total}</span>
            <span>{decisions.size} selected</span>
          </div>
          <div className="backlog-units">
            {current.items.map((unit) => (
              <ReviewUnit
                key={unit.id}
                unit={unit}
                reviewDate={current.date}
                decisions={decisions}
                interactive={interactive && !submitting && submitProblem === null}
                readable={readable}
                onDecision={choose}
                onOpenSource={(member, trigger) => setOpened({ member, trigger })}
              />
            ))}
          </div>
          {current.items.length === 0 ? <p className="backlog-empty">No open commitments need review.</p> : null}
          <nav className="backlog-pagination" aria-label="Backlog pages">
            <button type="button" disabled={pageIndex === 0 || submitting || decisions.size > 0} onClick={() => setPageIndex(pageIndex - 1)}>Previous</button>
            <button type="button" disabled={!current.page.hasMore || loadState.kind === "loading" || submitting || decisions.size > 0} onClick={nextPage}>
              {loadState.kind === "loading" ? "Loading…" : "Next"}
            </button>
          </nav>
          <div className="backlog-submit-bar">
            <span>{decisions.size === 0 ? "Select individual decisions to continue." : `${decisions.size} explicit ${decisions.size === 1 ? "decision" : "decisions"}`}</span>
            <div>
              {decisions.size > 0 ? <button type="button" disabled={submitting || submitProblem !== null} onClick={() => setDecisions(new Map())}>Clear</button> : null}
              <button ref={reviewButtonRef} type="button" disabled={!canConfirm || submitting || !interactive || submitProblem !== null} onClick={() => setConfirming(true)}>Review selected</button>
            </div>
          </div>
        </>
      ) : loadState.kind === "loading" ? <p className="backlog-loading" role="status">Loading backlog review…</p> : null}
      {confirming ? (
        <Confirmation
          decisions={decisions}
          submitting={submitting}
          onCancel={() => setConfirming(false)}
          onConfirm={submit}
          returnFocus={reviewButtonRef.current}
          interactive={interactive}
        />
      ) : null}
      {opened !== null ? (
        <SourceViewer
          citation={{ path: matchingSourceRef(opened.member).path, commit: current?.revision ?? matchingSourceRef(opened.member).commit }}
          client={client}
          returnFocus={opened.trigger}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </div>
  );
}
