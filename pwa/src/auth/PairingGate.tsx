import { useEffect, useMemo, useState } from "react";
import { DomeClient } from "../api/client";

type State = "checking" | "unavailable" | "unpaired" | "pairing" | "paired";

export function PairingGate({
  children,
}: {
  children: (client: DomeClient) => React.ReactNode;
}): React.ReactElement {
  const client = useMemo(() => new DomeClient(), []);
  const [state, setState] = useState<State>("checking");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // One-way migration from the prototype TokenGate: the browser no longer
    // retains the shared/root bearer once this shell loads.
    try { localStorage.removeItem("dome.token"); } catch { /* storage may be unavailable */ }
    void client.pairingStatus()
      .then((status) => {
        const csrfReady = status.schema !== "dome.device.pairing/v1" ||
          client.restoreCsrfFromCookie(document.cookie);
        setState(status.paired && csrfReady
          ? "paired"
          : status.available ? "unpaired" : "unavailable");
      })
      .catch(() => setState("unpaired"));
  }, [client]);

  if (state === "paired") return <>{children(client)}</>;
  return (
    <main className="gate">
      <div className="seed" aria-hidden="true" />
      <h1>Dome</h1>
      {state === "checking" ? <p className="lede">Checking this device…</p> : state === "unavailable" ? (
        <p className="lede">This host has not enabled browser pairing.</p>
      ) : (
        <>
          <p className="lede">Enter the pairing code shown on your Dome host.</p>
          <form onSubmit={(event) => {
            event.preventDefault();
            const code = draft.trim();
            if (code.length === 0 || state === "pairing") return;
            setState("pairing");
            setError(null);
            void client.pair(code)
              .then(() => setState("paired"))
              .catch((reason) => {
                setError(reason instanceof Error ? reason.message : String(reason));
                setState("unpaired");
              });
          }}>
            <input
              aria-label="Pairing code"
              type="password"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="one-time-code"
              placeholder="••••••••••••"
            />
            <button type="submit" disabled={state === "pairing"}>
              {state === "pairing" ? "Pairing…" : "Pair device"}
            </button>
          </form>
          {error !== null ? <p className="fine" role="alert">{error}</p> : (
            <p className="fine">the code is exchanged for a private browser cookie</p>
          )}
        </>
      )}
    </main>
  );
}
