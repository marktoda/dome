import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { DomeClient, type AgentTurnHandle } from "./api/client";
import type { AgentStopOutcome, AgentStreamOutcome, Recents as RecentsT, Today } from "./api/types";
import { PairingGate, type HomeAvailability, type HomeConnectionControl } from "./auth/PairingGate";
import { Brief } from "./components/Brief";
import { Recents } from "./components/Recents";
import { ChatTranscript } from "./components/ChatTranscript";
import { Composer } from "./components/Composer";
import { chatReducer } from "./chat/streamReducer";
import { CaptureQueue, type QueuedCapture } from "./capture/captureQueue";
import { UpdatePrompt } from "./offline/UpdatePrompt";
import { Connection, RecoveryCard } from "./components/Connection";
import { deriveProductSession } from "./connection/product-session";

function todayLabel(): string {
  try {
    return new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export function reconcileStoppedTurn(stream: AgentStreamOutcome, stop: AgentStopOutcome): AgentStreamOutcome {
  if (stream.kind !== "cancelled" || stream.source === "server") return stream;
  if (stop.kind === "session-missing" || stop.kind === "session-expired" || stop.kind === "failed") return stop;
  if (stop.kind === "cancelled") return { kind: "cancelled", source: "server" };
  return {
    kind: "failed",
    code: "stop-unconfirmed",
    message: "The response ended while stopping, but the server reported no active turn. Its final effects are unknown.",
    retryable: true,
  };
}

type ViewLoadState = "idle" | "loading" | "ready" | "failed";
type TodayRefreshState = "idle" | "loading" | "ready" | "failed";

function Screen({ client, availability, connection }: {
  client: DomeClient;
  availability: HomeAvailability;
  connection: HomeConnectionControl;
}): React.ReactElement {
  const captureQueue = useMemo(() => new CaptureQueue(), []);
  const [today, setToday] = useState<Today | null>(null);
  const [recents, setRecents] = useState<RecentsT | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, { messages: [] });
  const [briefCollapsed, setBriefCollapsed] = useState(false);
  const [ack, setAck] = useState<string | null>(null);
  const [pendingCaptures, setPendingCaptures] = useState<QueuedCapture[]>([]);
  const [storageStatus, setStorageStatus] = useState<"persistent" | "best-effort" | "unknown">("unknown");
  const [turnPhase, setTurnPhase] = useState<"idle" | "streaming" | "stopping" | "retryable" | "session-ended">("idle");
  const [todayRefreshState, setTodayRefreshState] = useState<TodayRefreshState>("idle");
  const [recentsLoad, setRecentsLoad] = useState<ViewLoadState>("idle");
  const todayRefreshSequence = useRef(0);
  const recentsRefreshSequence = useRef(0);
  const activeTurn = useRef<{ handle: AgentTurnHandle; question: string; stopping: boolean } | null>(null);
  const retryQuestion = useRef<string | null>(null);
  const hasMessages = chat.messages.length > 0;
  const session = useMemo(() => deriveProductSession({
    availability,
    readiness: connection.readiness,
    authRepair: connection.authRepair !== null,
  }), [availability, connection.authRepair, connection.readiness]);
  const access = session.access;
  const priorReadAccess = useRef(access.read);

  useLayoutEffect(() => {
    if (priorReadAccess.current && !access.read) {
      todayRefreshSequence.current++;
      recentsRefreshSequence.current++;
      setTodayRefreshState("idle");
      setRecentsLoad("idle");
    }
    priorReadAccess.current = access.read;
  }, [access.read]);

  const refreshToday = useCallback(() => {
    if (!access.read) return;
    const sequence = ++todayRefreshSequence.current;
    setTodayRefreshState("loading");
    void client.tasks().then(
      (nextToday) => {
        if (sequence !== todayRefreshSequence.current) return;
        setToday(nextToday);
        setTodayRefreshState("ready");
      },
      () => {
        if (sequence !== todayRefreshSequence.current) return;
        setTodayRefreshState("failed");
      },
    );
  }, [access.read, client]);

  const refreshRecents = useCallback(() => {
    if (!access.read) return;
    const sequence = ++recentsRefreshSequence.current;
    setRecentsLoad("loading");
    void client.recents().then(
      (nextRecents) => {
        if (sequence !== recentsRefreshSequence.current) return;
        setRecents(nextRecents);
        setRecentsLoad("ready");
      },
      () => {
        if (sequence !== recentsRefreshSequence.current) return;
        setRecentsLoad("failed");
      },
    );
  }, [access.read, client]);

  const refreshAll = useCallback(() => {
    refreshToday();
    refreshRecents();
  }, [refreshRecents, refreshToday]);

  const refreshPending = useCallback(async (): Promise<void> => {
    setPendingCaptures(await captureQueue.all());
  }, [captureQueue]);

  const drainCaptures = useCallback(async (): Promise<void> => {
    if (!access.captureReplay) return;
    const completed = await captureQueue.drain((request) => client.capture(request));
    await refreshPending();
    if (completed.length > 0) refreshAll();
  }, [access.captureReplay, captureQueue, client, refreshAll, refreshPending]);

  useEffect(() => {
    refreshAll();
    const onVis = (): void => { if (document.visibilityState === "visible") refreshAll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refreshAll]);

  useEffect(() => {
    void refreshPending().then(drainCaptures);
    const storage = navigator.storage;
    if (storage?.persist !== undefined) {
      void storage.persist().then((persistent) => {
        setStorageStatus(persistent ? "persistent" : "best-effort");
      }).catch(() => setStorageStatus("best-effort"));
    } else {
      setStorageStatus("best-effort");
    }
  }, [drainCaptures, refreshPending]);

  useEffect(() => () => {
    todayRefreshSequence.current++;
    recentsRefreshSequence.current++;
    const active = activeTurn.current;
    activeTurn.current = null;
    if (active !== null) void active.handle.stop();
  }, []);

  const captureText = async (text: string): Promise<void> => {
    await captureQueue.save({ text });
    await refreshPending();
    void drainCaptures();
  };

  const exportPending = async (): Promise<void> => {
    const blob = new Blob([await captureQueue.exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "dome-pending-captures.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const removePending = (id: string): void => {
    // A delete is a local-only operation. Reflect the user's intent
    // immediately, then restore IndexedDB truth if the durable delete fails.
    setPendingCaptures((current) => current.filter((item) => item.id !== id));
    void captureQueue.remove(id).catch(() => refreshPending());
  };

  const finishTurn = useCallback((turnId: string, question: string, outcome: AgentStreamOutcome): void => {
    dispatch({ kind: "outcome", turnId, outcome });
    retryQuestion.current = outcome.kind === "done" ? null : question;
    if (outcome.kind === "session-missing" || outcome.kind === "session-expired") setTurnPhase("session-ended");
    else if (outcome.kind === "cancelled" || (outcome.kind === "failed" && outcome.retryable)) setTurnPhase("retryable");
    else setTurnPhase("idle");
  }, []);

  const startAsk = useCallback((q: string): void => {
    if (!access.converse || activeTurn.current !== null) return;
    let turnId = "";
    const handle = client.startAgentTurn(q, (e) => {
      dispatch({ kind: "event", turnId, event: e });
      if (e.type === "done" && (e.changes?.length ?? 0) > 0) refreshAll();
    });
    turnId = handle.turnId;
    activeTurn.current = { handle, question: q, stopping: false };
    retryQuestion.current = null;
    dispatch({ kind: "turn-start", turnId, question: q });
    setTurnPhase("streaming");
    setBriefCollapsed(true);
    void handle.result.then((outcome) => {
      const active = activeTurn.current;
      if (active?.handle !== handle || active.stopping) return;
      activeTurn.current = null;
      finishTurn(handle.turnId, q, outcome);
    });
  }, [access.converse, client, finishTurn, refreshAll]);

  const onAsk = useCallback((q: string): void => {
    if (turnPhase === "session-ended") return;
    startAsk(q);
  }, [startAsk, turnPhase]);

  const stopTurn = useCallback((): void => {
    const active = activeTurn.current;
    if (active === null || active.stopping) return;
    active.stopping = true;
    setTurnPhase("stopping");
    void Promise.all([active.handle.result, active.handle.stop()]).then(([stream, stop]) => {
      if (activeTurn.current?.handle !== active.handle) return;
      activeTurn.current = null;
      finishTurn(active.handle.turnId, active.question, reconcileStoppedTurn(stream, stop));
    });
  }, [finishTurn]);

  const retryTurn = useCallback((): void => {
    const question = retryQuestion.current;
    if (!access.converse || question === null || activeTurn.current !== null) return;
    client.startNewConversation();
    dispatch({ kind: "boundary", text: "Retrying may repeat actions from the previous response." });
    startAsk(question);
  }, [access.converse, client, startAsk]);

  const newConversation = useCallback((): void => {
    if (!access.converse || activeTurn.current !== null) return;
    retryQuestion.current = null;
    setTurnPhase("idle");
    client.startNewConversation();
    dispatch({ kind: "boundary", text: "New conversation started." });
  }, [access.converse, client]);

  const resolve = (id: number, value: string): void => {
    if (!access.resolve) return;
    void client.resolve(id, value).then((result) => {
      if (result.status !== "answered" && result.status !== "already-answered") {
        setAck("Answer not saved · Try again");
        setTimeout(() => setAck(null), 2200);
        return;
      }
      setAck(`Answer saved · "${value}"`);
      setTimeout(() => setAck(null), 2200);
      refreshAll();
    }).catch(() => {
      setAck("Answer not saved · Try again");
      setTimeout(() => setAck(null), 2200);
    });
  };

  // Glance-and-settle: tap the checkbox -> settle 'close' via /settle. Brief
  // owns the optimistic strike-through + revert; this just makes the call and
  // reports success/failure, then refetches on success so the settled task
  // drops off the list for good.
  const settle = (blockId: string): Promise<boolean> => {
    if (!access.resolve) return Promise.resolve(false);
    return client.settle(blockId, "close")
      .then((r) => {
        const ok = r.status === "settled";
        if (ok) refreshAll();
        return ok;
      })
      .catch(() => false);
  };

  const todayRefreshMessage = todayRefreshState === "loading"
      ? "Refreshing Today…"
      : todayRefreshState === "ready"
        ? "Today is fresh."
        : todayRefreshState === "failed"
          ? "Today refresh failed. Previously loaded Today data may be stale."
          : "Today has not been loaded yet.";
  const visibleTodayRefreshState: TodayRefreshState = access.read ? todayRefreshState : "idle";

  return (
    <main className="screen">
      <header className="masthead">
        <span className="brand">Dome</span>
        <span className="meta">{todayLabel()}<span className={`availability-dot ${session.connection.tone}`} aria-hidden="true" /></span>
      </header>
      <Connection session={session} />
      {session.recovery !== null ? (
        <RecoveryCard session={session} onRetry={connection.recheck} authRepair={connection.authRepair} />
      ) : null}
      {pendingCaptures.length > 0 ? (
        <section className="capture-outbox" aria-label="pending captures">
          <div className="capture-outbox-head">
            <strong>{pendingCaptures.length} saved locally</strong>
            <span>offline storage: {storageStatus}</span>
            <button type="button" disabled={!access.captureReplay} onClick={() => { void drainCaptures(); }}>Retry</button>
            <button type="button" onClick={() => { void exportPending(); }}>Export</button>
          </div>
          {pendingCaptures.map((item) => (
            <div
              className="capture-outbox-item"
              data-queue-state={item.state}
              data-attempt-category={item.attempts === 0 ? "zero" : item.attempts === 1 ? "one" : "many"}
              key={item.id}
            >
              <span>{item.text}</span>
              <small>{item.state}{item.lastError !== undefined ? ` · ${item.lastError}` : ""}</small>
              <button type="button" aria-label={`delete pending capture ${item.id}`} onClick={() => removePending(item.id)}>Delete</button>
            </div>
          ))}
        </section>
      ) : null}
      <div className="scroll">
        <section className={`today-panel ${visibleTodayRefreshState}`} aria-label="Today">
          <div className="surface-refresh">
            <span>Today</span>
            <button
              type="button"
              aria-label="Refresh Today"
              aria-describedby="today-refresh-status"
              aria-busy={visibleTodayRefreshState === "loading"}
              disabled={!access.read || todayRefreshState === "loading"}
              onClick={refreshToday}
            >{todayRefreshState === "failed" ? "Retry" : "Refresh"}</button>
            <p
              id="today-refresh-status"
              className={todayRefreshState === "failed" || todayRefreshState === "loading" ? "" : "sr-only"}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >{todayRefreshMessage}</p>
          </div>
          {today !== null ? (
            <Brief today={today} onResolve={resolve} onSettle={settle} collapsed={briefCollapsed} hasMessages={hasMessages} onToggle={() => setBriefCollapsed((c) => !c)} interactive={access.resolve} />
          ) : todayRefreshState === "failed" ? (
            <p className="view-error">Today could not be refreshed. Try again when Dome Home is available.</p>
          ) : null}
        </section>
        <details className="activity-wrap" key={recentsLoad === "failed" ? "activity-failed" : "activity"} open={recentsLoad === "failed" ? true : undefined}>
          <summary>Activity{recents !== null ? ` · ${recents.count}` : ""}</summary>
          {recentsLoad === "failed" ? (
            <div className="surface-error" role="status">
              <span>Activity could not be refreshed. Previously loaded activity may be stale.</span>
              <button type="button" disabled={!access.read} onClick={refreshRecents}>Retry Activity</button>
            </div>
          ) : null}
          {recents !== null ? <Recents recents={recents} client={client} interactive={access.read} /> : null}
        </details>
        <ChatTranscript state={chat} client={client} interactive={access.read} />
      </div>
      {ack !== null ? <div className="ack-wrap"><div className="ack" role="status" aria-live="polite" aria-atomic="true">{ack}</div></div> : null}
      <Composer
        onAsk={onAsk}
        turnPhase={turnPhase}
        onStop={stopTurn}
        onRetry={retryTurn}
        onNewConversation={newConversation}
        onCapture={captureText}
        onTranscribe={(blob) => client.transcribe(blob).then((t) => t.text)}
        onFile={captureText}
        availability={availability}
        askEnabled={access.converse}
        voiceEnabled={access.voice}
      />
    </main>
  );
}

export default function App(): React.ReactElement {
  return (
    <>
      <PairingGate>{(client, availability, connection) => <Screen client={client} availability={availability} connection={connection} />}</PairingGate>
      <UpdatePrompt />
    </>
  );
}
