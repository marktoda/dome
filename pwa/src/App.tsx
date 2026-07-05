import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { DomeClient } from "./api/client";
import type { Recents as RecentsT, Today } from "./api/types";
import { TokenGate } from "./auth/TokenGate";
import { Brief } from "./components/Brief";
import { Recents } from "./components/Recents";
import { ChatTranscript } from "./components/ChatTranscript";
import { Composer } from "./components/Composer";
import { chatReducer } from "./chat/streamReducer";

function todayLabel(): string {
  try {
    return new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function Screen({ token }: { token: string }): React.ReactElement {
  const client = useMemo(() => new DomeClient(token), [token]);
  const [today, setToday] = useState<Today | null>(null);
  const [recents, setRecents] = useState<RecentsT | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, { messages: [] });
  const [briefCollapsed, setBriefCollapsed] = useState(false);
  const [ack, setAck] = useState<string | null>(null);
  const hasMessages = chat.messages.length > 0;

  const refresh = useCallback(() => {
    client.tasks().then(setToday).catch(() => {});
    client.recents().then(setRecents).catch(() => {});
  }, [client]);

  useEffect(() => {
    refresh();
    const onVis = (): void => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);

  const onAsk = (q: string): void => {
    dispatch({ kind: "user", text: q });
    dispatch({ kind: "assistant-start" });
    setBriefCollapsed(true);
    void client.agentStream(q, (e) => {
      dispatch({ kind: "event", event: e });
      if (e.type === "done" && (e.changes?.length ?? 0) > 0) refresh();
    });
  };

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
      <div className="scroll">
        {today !== null ? (
          <Brief today={today} onResolve={resolve} onSettle={settle} collapsed={briefCollapsed} hasMessages={hasMessages} onToggle={() => setBriefCollapsed((c) => !c)} />
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
        onTranscribe={(blob) => client.transcribe(blob).then((t) => t.text)}
        onFile={(text) => client.capture({ text }).then((r) => r.path)}
      />
    </main>
  );
}

export default function App(): React.ReactElement {
  return <TokenGate>{(token) => <Screen token={token} />}</TokenGate>;
}
