import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { DomeClient, type AgentTurnHandle } from "./api/client";
import type { AgentStopOutcome, AgentStreamOutcome, Recents as RecentsT, Today } from "./api/types";
import { PairingGate } from "./auth/PairingGate";
import { Brief } from "./components/Brief";
import { Recents } from "./components/Recents";
import { ChatTranscript } from "./components/ChatTranscript";
import { Composer } from "./components/Composer";
import { chatReducer } from "./chat/streamReducer";
import { CaptureQueue, type QueuedCapture } from "./capture/captureQueue";

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

function Screen({ client }: { client: DomeClient }): React.ReactElement {
  const captureQueue = useMemo(() => new CaptureQueue(), []);
  const [today, setToday] = useState<Today | null>(null);
  const [recents, setRecents] = useState<RecentsT | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, { messages: [] });
  const [briefCollapsed, setBriefCollapsed] = useState(false);
  const [ack, setAck] = useState<string | null>(null);
  const [pendingCaptures, setPendingCaptures] = useState<QueuedCapture[]>([]);
  const [storageStatus, setStorageStatus] = useState<"persistent" | "best-effort" | "unknown">("unknown");
  const [turnPhase, setTurnPhase] = useState<"idle" | "streaming" | "stopping" | "retryable" | "session-ended">("idle");
  const activeTurn = useRef<{ handle: AgentTurnHandle; question: string; stopping: boolean } | null>(null);
  const retryQuestion = useRef<string | null>(null);
  const hasMessages = chat.messages.length > 0;

  const refresh = useCallback(() => {
    client.tasks().then(setToday).catch(() => {});
    client.recents().then(setRecents).catch(() => {});
  }, [client]);

  const refreshPending = useCallback(async (): Promise<void> => {
    setPendingCaptures(await captureQueue.all());
  }, [captureQueue]);

  const drainCaptures = useCallback(async (): Promise<void> => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const completed = await captureQueue.drain((request) => client.capture(request));
    await refreshPending();
    if (completed.length > 0) refresh();
  }, [captureQueue, client, refresh, refreshPending]);

  useEffect(() => {
    refresh();
    const onVis = (): void => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);

  useEffect(() => {
    void refreshPending().then(drainCaptures);
    const onOnline = (): void => { void drainCaptures(); };
    window.addEventListener("online", onOnline);
    const storage = navigator.storage;
    if (storage?.persist !== undefined) {
      void storage.persist().then((persistent) => {
        setStorageStatus(persistent ? "persistent" : "best-effort");
      }).catch(() => setStorageStatus("best-effort"));
    } else {
      setStorageStatus("best-effort");
    }
    return () => window.removeEventListener("online", onOnline);
  }, [drainCaptures, refreshPending]);

  useEffect(() => () => {
    const active = activeTurn.current;
    activeTurn.current = null;
    if (active !== null) void active.handle.stop();
  }, []);

  const captureText = async (text: string): Promise<string> => {
    await captureQueue.save({ text });
    await refreshPending();
    void drainCaptures();
    return "Saved locally · pending";
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

  const finishTurn = useCallback((turnId: string, question: string, outcome: AgentStreamOutcome): void => {
    dispatch({ kind: "outcome", turnId, outcome });
    retryQuestion.current = outcome.kind === "done" ? null : question;
    if (outcome.kind === "session-missing" || outcome.kind === "session-expired") setTurnPhase("session-ended");
    else if (outcome.kind === "cancelled" || (outcome.kind === "failed" && outcome.retryable)) setTurnPhase("retryable");
    else setTurnPhase("idle");
  }, []);

  const startAsk = useCallback((q: string): void => {
    if (activeTurn.current !== null) return;
    let turnId = "";
    const handle = client.startAgentTurn(q, (e) => {
      dispatch({ kind: "event", turnId, event: e });
      if (e.type === "done" && (e.changes?.length ?? 0) > 0) refresh();
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
  }, [client, finishTurn, refresh]);

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
    if (question === null || activeTurn.current !== null) return;
    client.startNewConversation();
    dispatch({ kind: "boundary", text: "Retrying may repeat actions from the previous response." });
    startAsk(question);
  }, [client, startAsk]);

  const newConversation = useCallback((): void => {
    if (activeTurn.current !== null) return;
    retryQuestion.current = null;
    setTurnPhase("idle");
    client.startNewConversation();
    dispatch({ kind: "boundary", text: "New conversation started." });
  }, [client]);

  // Optimistic: drop the answered question immediately, toast the answer, then
  // resolve against the API and refetch to confirm.
  const resolve = (id: number, value: string): void => {
    setToday((prev) =>
      prev === null ? prev : {
        ...prev,
        questions: prev.questions.filter((q) => q.id !== id),
      });
    setAck(`Answered · "${value}"`);
    setTimeout(() => setAck(null), 2200);
    void client.resolve(id, value).then(refresh).catch(() => {});
  };

  const review = (id: number, decision: "apply" | "reject"): void => {
    setToday((prev) => prev === null
      ? prev
      : { ...prev, reviews: (prev.reviews ?? []).filter((review) => review.id !== id) });
    setAck(decision === "apply" ? "Proposal applied" : "Proposal rejected");
    setTimeout(() => setAck(null), 2200);
    const request = decision === "apply"
      ? client.applyProposal(id)
      : client.rejectProposal(id);
    void request.then(refresh).catch(refresh);
  };

  // Glance-and-settle: tap the checkbox -> settle 'close' via /settle. Brief
  // owns the optimistic strike-through + revert; this just makes the call and
  // reports success/failure, then refetches on success so the settled task
  // drops off the list for good.
  const settle = (blockId: string): Promise<boolean> => {
    return client.settle(blockId, "close")
      .then((r) => {
        const ok = r.status === "settled";
        if (ok) refresh();
        return ok;
      })
      .catch(() => false);
  };

  return (
    <main className="screen">
      <header className="masthead">
        <span className="brand">Dome</span>
        <span className="meta">{todayLabel()}<span className="pulse" aria-hidden="true" /></span>
      </header>
      {pendingCaptures.length > 0 ? (
        <section className="capture-outbox" aria-label="pending captures">
          <div className="capture-outbox-head">
            <strong>{pendingCaptures.length} saved locally</strong>
            <span>offline storage: {storageStatus}</span>
            <button type="button" onClick={() => { void drainCaptures(); }}>Retry</button>
            <button type="button" onClick={() => { void exportPending(); }}>Export</button>
          </div>
          {pendingCaptures.map((item) => (
            <div className="capture-outbox-item" key={item.id}>
              <span>{item.text}</span>
              <small>{item.state}{item.lastError !== undefined ? ` · ${item.lastError}` : ""}</small>
              <button type="button" aria-label={`delete pending capture ${item.id}`} onClick={() => {
                void captureQueue.remove(item.id).then(refreshPending);
              }}>Delete</button>
            </div>
          ))}
        </section>
      ) : null}
      <div className="scroll">
        {today !== null ? (
          <Brief today={today} onResolve={resolve} onReview={review} onSettle={settle} collapsed={briefCollapsed} hasMessages={hasMessages} onToggle={() => setBriefCollapsed((c) => !c)} />
        ) : null}
        {recents !== null ? (
          <details className="recents-wrap">
            <summary>recents · {recents.count}</summary>
            <Recents recents={recents} />
          </details>
        ) : null}
        <ChatTranscript state={chat} />
      </div>
      {ack !== null ? <div className="ack-wrap"><div className="ack">{ack}</div></div> : null}
      <Composer
        onAsk={onAsk}
        turnPhase={turnPhase}
        onStop={stopTurn}
        onRetry={retryTurn}
        onNewConversation={newConversation}
        onCapture={captureText}
        onTranscribe={(blob) => client.transcribe(blob).then((t) => t.text)}
        onFile={captureText}
      />
    </main>
  );
}

export default function App(): React.ReactElement {
  return <PairingGate>{(client) => <Screen client={client} />}</PairingGate>;
}
