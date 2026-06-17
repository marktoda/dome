import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { DomeClient } from "./api/client";
import type { Recents as RecentsT, Today } from "./api/types";
import { TokenGate } from "./auth/TokenGate";
import { Brief } from "./components/Brief";
import { Recents } from "./components/Recents";
import { ChatTranscript } from "./components/ChatTranscript";
import { Composer } from "./components/Composer";
import { chatReducer } from "./chat/streamReducer";

function Screen({ token }: { token: string }): React.ReactElement {
  const client = useMemo(() => new DomeClient(token), [token]);
  const [today, setToday] = useState<Today | null>(null);
  const [recents, setRecents] = useState<RecentsT | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, { messages: [] });

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
    void client.askStream(q, (e) => dispatch({ kind: "event", event: e }));
  };

  return (
    <main className="screen">
      {today !== null ? <Brief today={today} onResolve={(id, v) => { void client.resolve(id, v).then(refresh); }} /> : null}
      {recents !== null ? <details className="recents-wrap"><summary>recents ({recents.count})</summary><Recents recents={recents} /></details> : null}
      <ChatTranscript state={chat} />
      <Composer
        onAsk={onAsk}
        onTranscribe={(blob) => client.transcribe(blob).then((t) => t.text)}
        onFile={(text) => client.capture({ text }).then(() => undefined)}
      />
    </main>
  );
}

export default function App(): React.ReactElement {
  return <TokenGate>{(token) => <Screen token={token} />}</TokenGate>;
}
