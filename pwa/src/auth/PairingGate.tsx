import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DomeClient, type ConnectionFailure, type ReadinessResult } from "../api/client";
import type { HomeAvailability, HomeReadinessEvidence } from "../connection/product-session";

export type { HomeAvailability, HomeReadinessEvidence } from "../connection/product-session";
export type HomeConnectionControl = Readonly<{
  recheck: () => void;
  readiness: HomeReadinessEvidence;
  authRepair: Readonly<{
    pairing: boolean;
    error: string | null;
    pair: (code: string) => void;
  }> | null;
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
  const [repairRequired, setRepairRequired] = useState(false);
  const [repairPairing, setRepairPairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<HomeReadinessEvidence>({
    document: null,
    stale: false,
    issue: null,
  });
  const recheckRef = useRef<() => void>(() => {});
  const evidenceGeneration = useRef(0);
  const pairedThisSession = useRef(false);
  const pairingInFlight = useRef(false);
  const client = useMemo(() => {
    let ownedClient!: DomeClient;
    ownedClient = new DomeClient("", "", () => {
      const generation = evidenceGeneration.current;
      return (failure: ConnectionFailure) => {
        if (generation !== evidenceGeneration.current) return;
        evidenceGeneration.current++;
        if (failure.kind === "auth-required") {
          const hadLocalEvidence = ownedClient.restoreCsrfFromCookie(document.cookie) || pairedThisSession.current;
          pairedThisSession.current = false;
          setAvailability("available");
          setReadiness((current) => ({ ...current, stale: current.document !== null }));
          setRepairRequired(hadLocalEvidence);
          setRepairPairing(false);
          setRepairError(null);
          setState(hadLocalEvidence ? "paired" : "unpaired");
          return;
        }
        setAvailability(navigator.onLine === false ? "offline" : "unreachable");
        setReadiness((current) => ({ ...current, stale: current.document !== null }));
        setState(ownedClient.restoreCsrfFromCookie(document.cookie) || pairedThisSession.current
          ? "paired"
          : "connection-required");
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
    const localEvidence = (): boolean =>
      client.restoreCsrfFromCookie(document.cookie) || pairedThisSession.current;
    const acceptReadiness = (result: ReadinessResult, generation: number): void => {
      if (!active || generation !== evidenceGeneration.current) return;
      if (result.kind === "auth-required") {
        const hadLocalEvidence = localEvidence();
        pairedThisSession.current = false;
        setAvailability("available");
        setReadiness((current) => ({ ...current, stale: current.document !== null }));
        setRepairRequired(hadLocalEvidence);
        setRepairPairing(false);
        setRepairError(null);
        setState(hadLocalEvidence ? "paired" : "unpaired");
        return;
      }
      if (result.kind === "offline" || result.kind === "unreachable") {
        setAvailability(result.kind);
        setReadiness((current) => ({ ...current, stale: current.document !== null }));
        setState(localEvidence() ? "paired" : "connection-required");
        return;
      }
      setAvailability("available");
      setState("paired");
      if (result.kind === "ready") {
        setRepairRequired(false);
        setRepairPairing(false);
        setRepairError(null);
        setReadiness({ document: result.document, stale: false, issue: null });
      } else {
        setReadiness((current) => ({
          document: current.document,
          stale: current.document !== null,
          issue: result.kind,
        }));
      }
    };
    const check = (): void => {
      if (pairingInFlight.current) return;
      if (navigator.onLine === false) {
        evidenceGeneration.current++;
        setAvailability("offline");
        setReadiness((current) => ({ ...current, stale: current.document !== null }));
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
      const proof = localEvidence()
        ? client.readiness()
        : client.pairingStatus().then(async (status): Promise<ReadinessResult | null> => {
          if (!status.paired || status.schema === "dome.device.pairing/v1") {
            if (!active || generation !== evidenceGeneration.current) return null;
            setAvailability("available");
            setState(status.available ? "unpaired" : "unavailable");
            return null;
          }
          return client.readiness();
        });
      void proof.then((result) => {
        if (result !== null) acceptReadiness(result, generation);
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
      setReadiness((current) => ({ ...current, stale: current.document !== null }));
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

  const pair = useCallback((code: string, repair: boolean): void => {
    const value = code.trim();
    if (value.length === 0 || pairingInFlight.current) return;
    pairingInFlight.current = true;
    const generation = ++evidenceGeneration.current;
    if (repair) {
      setRepairPairing(true);
      setRepairError(null);
    } else {
      setState("pairing");
      setError(null);
    }
    void client.pair(value)
      .then(() => {
        pairingInFlight.current = false;
        if (repair) setRepairPairing(false);
        if (generation !== evidenceGeneration.current) return;
        pairedThisSession.current = true;
        setAvailability("available");
        setReadiness((current) => ({ ...current, stale: current.document !== null }));
        setRepairRequired(false);
        setRepairPairing(false);
        setRepairError(null);
        setState("paired");
        queueMicrotask(recheck);
      })
      .catch((reason) => {
        pairingInFlight.current = false;
        if (repair) setRepairPairing(false);
        if (generation !== evidenceGeneration.current) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        if (repair) {
          setRepairPairing(false);
          setRepairError(message);
        } else {
          setError(message);
          setState("unpaired");
        }
      });
  }, [client, recheck]);

  if (state === "paired") {
    return <>{children(client, availability, {
      recheck,
      readiness,
      authRepair: repairRequired ? {
        pairing: repairPairing,
        error: repairError,
        pair: (code) => pair(code, true),
      } : null,
    })}</>;
  }
  return (
    <main className="gate" aria-busy={state === "checking" || state === "pairing"}>
      <div className="seed" aria-hidden="true" />
      <h1>Dome</h1>
      {state === "checking" ? <p className="lede" role="status" aria-live="polite">Checking this device…</p> : state === "connection-required" ? (
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
            pair(draft, false);
          }}>
            {state === "pairing" ? <span className="sr-only" role="status" aria-live="polite">Pairing device…</span> : null}
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
