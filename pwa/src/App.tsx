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
  const [viewLoad, setViewLoad] = useState<{ today: ViewLoadState; recents: ViewLoadState }>({ today: "idle", recents: "idle" });
  const refreshSequence = useRef(0);
  const activeTurn = useRef<{ handle: AgentTurnHandle; question: string; stopping: boolean } | null>(null);
  const retryQuestion = useRef<string | null>(null);
  const hasMessages = chat.messages.length > 0;
  const remoteAvailable = availability === "available";
  const priorRemoteAvailable = useRef(remoteAvailable);

  useLayoutEffect(() => {
    if (priorRemoteAvailable.current && !remoteAvailable) refreshSequence.current++;
    priorRemoteAvailable.current = remoteAvailable;
  }, [remoteAvailable]);

  const refresh = useCallback(() => {
    if (!remoteAvailable) return;
    const sequence = ++refreshSequence.current;
    setViewLoad({ today: "loading", recents: "loading" });
    void Promise.allSettled([client.tasks(), client.recents()]).then(([todayResult, recentsResult]) => {
      if (sequence !== refreshSequence.current) return;
      if (todayResult.status === "fulfilled") setToday(todayResult.value);
      if (recentsResult.status === "fulfilled") setRecents(recentsResult.value);
      setViewLoad({
        today: todayResult.status === "fulfilled" ? "ready" : "failed",
        recents: recentsResult.status === "fulfilled" ? "ready" : "failed",
      });
    });
  }, [client, remoteAvailable]);

  const refreshPending = useCallback(async (): Promise<void> => {
    setPendingCaptures(await captureQueue.all());
  }, [captureQueue]);

  const drainCaptures = useCallback(async (): Promise<void> => {
    if (!remoteAvailable) return;
    const completed = await captureQueue.drain((request) => client.capture(request));
    await refreshPending();
    if (completed.length > 0) refresh();
  }, [captureQueue, client, refresh, refreshPending, remoteAvailable]);

  useEffect(() => {
    refresh();
    const onVis = (): void => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);

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
    refreshSequence.current++;
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

  const finishTurn = useCallback((turnId: string, question: string, outcome: AgentStreamOutcome): void => {
    dispatch({ kind: "outcome", turnId, outcome });
    retryQuestion.current = outcome.kind === "done" ? null : question;
    if (outcome.kind === "session-missing" || outcome.kind === "session-expired") setTurnPhase("session-ended");
    else if (outcome.kind === "cancelled" || (outcome.kind === "failed" && outcome.retryable)) setTurnPhase("retryable");
    else setTurnPhase("idle");
  }, []);

  const startAsk = useCallback((q: string): void => {
    if (!remoteAvailable || activeTurn.current !== null) return;
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
  }, [client, finishTurn, refresh, remoteAvailable]);

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
    if (!remoteAvailable || question === null || activeTurn.current !== null) return;
    client.startNewConversation();
    dispatch({ kind: "boundary", text: "Retrying may repeat actions from the previous response." });
    startAsk(question);
  }, [client, remoteAvailable, startAsk]);

  const newConversation = useCallback((): void => {
    if (!remoteAvailable || activeTurn.current !== null) return;
    retryQuestion.current = null;
    setTurnPhase("idle");
    client.startNewConversation();
    dispatch({ kind: "boundary", text: "New conversation started." });
  }, [client, remoteAvailable]);

  const resolve = (id: number, value: string): void => {
    if (!remoteAvailable) return;
    void client.resolve(id, value).then((result) => {
      if (result.status !== "answered" && result.status !== "already-answered") {
        setAck("Answer not saved · Try again");
        setTimeout(() => setAck(null), 2200);
        return;
      }
      setAck(`Answer saved · "${value}"`);
      setTimeout(() => setAck(null), 2200);
      refresh();
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
    if (!remoteAvailable) return Promise.resolve(false);
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
        <span className="meta">{todayLabel()}<span className={`availability-dot ${availability}`} aria-hidden="true" /></span>
      </header>
      {!remoteAvailable ? (
        <div className="availability-banner" role="status">
          <strong>{availability === "offline" ? "Offline" : "Dome Home unavailable"}</strong>
          <span>{today === null && recents === null
            ? "Live data is unavailable. Text captures stay on this device."
            : "Showing the last loaded data; it may be stale. Text captures stay on this device."}</span>
          <button type="button" onClick={connection.recheck}>Retry connection</button>
        </div>
      ) : null}
      {remoteAvailable && (viewLoad.today === "failed" || viewLoad.recents === "failed") ? (
        <div className="availability-banner live-data-warning" role="status">
          <strong>Live views incomplete</strong>
          <span>{viewLoad.today === "failed" && viewLoad.recents === "failed"
            ? "Today and Activity could not be refreshed. Home is connected; previously loaded data may be stale."
            : viewLoad.today === "failed"
              ? "Today could not be refreshed. Activity is current; any Today data shown may be stale."
              : "Activity could not be refreshed. Today is current; any Activity data shown may be stale."}</span>
          <button type="button" onClick={refresh}>Retry live data</button>
        </div>
      ) : null}
      {pendingCaptures.length > 0 ? (
        <section className="capture-outbox" aria-label="pending captures">
          <div className="capture-outbox-head">
            <strong>{pendingCaptures.length} saved locally</strong>
            <span>offline storage: {storageStatus}</span>
            <button type="button" disabled={!remoteAvailable} onClick={() => { void drainCaptures(); }}>Retry</button>
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
          <Brief today={today} onResolve={resolve} onSettle={settle} collapsed={briefCollapsed} hasMessages={hasMessages} onToggle={() => setBriefCollapsed((c) => !c)} interactive={remoteAvailable} />
        ) : null}
        {recents !== null ? (
          <details className="recents-wrap">
            <summary>recents · {recents.count}</summary>
            <Recents recents={recents} />
          </details>
        ) : null}
        <ChatTranscript state={chat} client={client} interactive={remoteAvailable} />
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
        availability={availability}
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
