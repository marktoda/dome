import { useState } from "react";
import type { HomeConnectionControl } from "../auth/PairingGate";
import type { ProductSession } from "../connection/product-session";

type Props = {
  session: ProductSession;
};

export function Connection({ session }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const document = session.document;
  return (
    <section className={`connection${open ? " open" : ""}`} aria-label="Dome Home connection">
      <button
        className="connection-summary"
        type="button"
        aria-expanded={open}
        aria-controls="dome-connection-details"
        onClick={() => setOpen((value) => !value)}
      >Connection · {session.connection.label}</button>
      {open ? <div id="dome-connection-details" className="connection-body" role="region" aria-label="Connection details" tabIndex={0}>
        {document === null ? <p>No connection details are available yet.</p> : (
          <>
            <p>{document.vault.name} · {document.device.name}</p>
            <p className="connection-access">Available now: {[
              session.access.read ? "Today and Activity" : null,
              session.access.converse ? "Ask" : null,
              session.access.voice ? "voice" : null,
              session.access.captureReplay ? "Capture" : null,
              session.access.resolve ? "decisions" : null,
            ].filter((item) => item !== null).join(", ") || "text capture only"}.</p>
            <details className="technical-details">
              <summary>Technical details</summary>
              <dl>
                <dt>Version</dt><dd>{document.productVersion}</dd>
                <dt>Product readiness</dt><dd>{session.staleContext ? "stale" : "validated"}</dd>
                <dt>Host</dt><dd>{document.host.state}</dd>
                <dt>Adoption</dt><dd>{document.adoption.state}</dd>
                <dt>Model</dt><dd>{document.model.state}</dd>
                <dt>Transcription</dt><dd>{document.transcription.state}</dd>
                <dt>Capabilities</dt><dd>{document.device.capabilities.length > 0 ? document.device.capabilities.join(", ") : "none"}</dd>
              </dl>
            </details>
          </>
        )}
      </div> : null}
    </section>
  );
}

export function RecoveryCard({ session, onRetry, authRepair }: {
  session: ProductSession;
  onRetry: () => void;
  authRepair: HomeConnectionControl["authRepair"];
}): React.ReactElement {
  const [code, setCode] = useState("");
  const recovery = session.recovery;
  if (recovery === null) throw new Error("RecoveryCard requires a session recovery");
  const repair = recovery.kind === "repair" ? authRepair : null;
  return (
    <section className={`recovery-card recovery-${session.kind}`} aria-labelledby="recovery-title">
      <div className="recovery-message" role="status">
        <strong id="recovery-title">{recovery.title}</strong>
        <span>{recovery.detail}</span>
      </div>
      {recovery.kind === "repair" && repair !== null ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!repair.pairing && code.trim().length > 0) repair.pair(code);
        }}>
          <input
            aria-label="New pairing code"
            type="password"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="one-time-code"
            disabled={repair.pairing}
          />
          <button type="submit" disabled={repair.pairing || code.trim().length === 0}>
            {repair.pairing ? "Pairing…" : "Pair again"}
          </button>
          {repair.error !== null ? <span role="alert">{repair.error}</span> : null}
        </form>
      ) : recovery.kind === "retry" ? (
        <button type="button" onClick={onRetry}>{recovery.actionLabel}</button>
      ) : null}
    </section>
  );
}
