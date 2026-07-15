import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DomeClient } from "../api/client";

export type HomeAvailability = "available" | "offline" | "unreachable";
export type HomeConnectionControl = Readonly<{
  recheck: () => void;
}>;
type State = "checking" | "unavailable" | "connection-required" | "status-error" | "unpaired" | "pairing" | "paired";

export function PairingGate({
  children,
}: {
  children: (client: DomeClient, availability: HomeAvailability, connection: HomeConnectionControl) => React.ReactNode;
}): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<HomeAvailability>("available");
  const recheckRef = useRef<() => void>(() => {});
  const evidenceGeneration = useRef(0);
  const client = useMemo(() => {
    let ownedClient!: DomeClient;
    ownedClient = new DomeClient("", "", () => {
      const generation = evidenceGeneration.current;
      return () => {
        if (generation !== evidenceGeneration.current) return;
        evidenceGeneration.current++;
        setAvailability(navigator.onLine === false ? "offline" : "unreachable");
        setState(ownedClient.restoreCsrfFromCookie(document.cookie) ? "paired" : "connection-required");
      };
    });
    return ownedClient;
  }, []);
  const recheck = useCallback((): void => recheckRef.current(), []);

  useEffect(() => {
    // One-way migration from the prototype TokenGate: the browser no longer
    // retains the shared/root bearer once this shell loads.
    try { localStorage.removeItem("dome.token"); } catch { /* storage may be unavailable */ }
    let active = true;
    let inFlight = false;
    let inFlightGeneration = 0;
    let queued = false;
    const localEvidence = (): boolean => client.restoreCsrfFromCookie(document.cookie);
    const check = (): void => {
      if (navigator.onLine === false) {
        evidenceGeneration.current++;
        setAvailability("offline");
        setState(localEvidence() ? "paired" : "connection-required");
        return;
      }
      if (inFlight) {
        // Duplicate retries share the current proof. Queue only when newer
        // offline/transport evidence already invalidated that proof.
        if (inFlightGeneration !== evidenceGeneration.current) queued = true;
        return;
      }
      const generation = ++evidenceGeneration.current;
      inFlight = true;
      inFlightGeneration = generation;
      void client.pairingStatus().then((status) => {
        if (!active || generation !== evidenceGeneration.current) return;
        const csrfReady = status.schema !== "dome.device.pairing/v1" || localEvidence();
        setAvailability("available");
        setState(status.paired && csrfReady
          ? "paired"
          : status.available ? "unpaired" : "unavailable");
      }).catch(() => {
        if (!active || generation !== evidenceGeneration.current) return;
        setAvailability("available");
        setState(localEvidence() ? "paired" : "status-error");
      }).finally(() => {
        inFlight = false;
        if (active && queued) {
          queued = false;
          check();
        }
      });
    };
    const offline = (): void => {
      evidenceGeneration.current++;
      setAvailability("offline");
      setState(localEvidence() ? "paired" : "connection-required");
    };
    const online = (): void => { check(); };
    const visible = (): void => { if (document.visibilityState === "visible") check(); };
    recheckRef.current = check;
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    check();
    return () => {
      active = false;
      evidenceGeneration.current++;
      recheckRef.current = () => {};
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [client]);

  if (state === "paired") {
    return <>{children(client, availability, { recheck })}</>;
  }
  return (
    <main className="gate">
      <div className="seed" aria-hidden="true" />
      <h1>Dome</h1>
      {state === "checking" ? <p className="lede">Checking this device…</p> : state === "connection-required" ? (
        <>
          <p className="lede" role="status">Dome Home is unavailable. Connect to your Home before pairing this device.</p>
          <button type="button" onClick={recheck}>Retry connection</button>
        </>
      ) : state === "unavailable" ? (
        <p className="lede">This host has not enabled browser pairing.</p>
      ) : state === "status-error" ? (
        <>
          <p className="lede" role="status">Dome Home responded, but its pairing status could not be read.</p>
          <button type="button" onClick={recheck}>Retry connection</button>
        </>
      ) : (
        <>
          <p className="lede">Enter the pairing code shown on your Dome host.</p>
          <form onSubmit={(event) => {
            event.preventDefault();
            const code = draft.trim();
            if (code.length === 0 || state === "pairing") return;
            const generation = ++evidenceGeneration.current;
            setState("pairing");
            setError(null);
            void client.pair(code)
              .then(() => {
                if (generation !== evidenceGeneration.current) return;
                setAvailability("available");
                setState("paired");
              })
              .catch((reason) => {
                if (generation !== evidenceGeneration.current) return;
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
