import { useState } from "react";
import type { HomeAvailability, HomeConnectionControl, HomeReadinessEvidence } from "../auth/PairingGate";
import type { ProductAccess } from "../connection/product-access";

type Props = {
  availability: HomeAvailability;
  readiness: HomeReadinessEvidence;
  access: ProductAccess;
};

export function Connection({ availability, readiness, access }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const document = readiness.document;
  const status = availability !== "available"
    ? availability
    : readiness.issue === "incompatible"
      ? "incompatible"
      : readiness.issue === "readiness-failed"
        ? "readiness unavailable"
        : readiness.stale
          ? "stale"
          : document?.host.state ?? "checking";
  return (
    <section className={`connection${open ? " open" : ""}`} aria-label="Dome Home connection">
      <button
        className="connection-summary"
        type="button"
        aria-expanded={open}
        aria-controls="dome-connection-details"
        onClick={() => setOpen((value) => !value)}
      >Connection · {status}</button>
      {open ? <div id="dome-connection-details" className="connection-body" role="region" aria-label="Connection details" tabIndex={0}>
        {readiness.stale ? <p role="status">Last known details are stale and do not enable remote actions.</p> : null}
        {readiness.issue === "incompatible" ? (
          <p role="alert">This Dome Home uses an incompatible readiness contract. Update Dome before continuing.</p>
        ) : readiness.issue === "readiness-failed" ? (
          <p role="status">Dome Home responded, but product readiness is unavailable.</p>
        ) : null}
        {document === null ? <p>No validated product details are available.</p> : (
          <>
            <dl>
              <dt>Vault</dt><dd>{document.vault.name}</dd>
              <dt>Device</dt><dd>{document.device.name}</dd>
              <dt>Version</dt><dd>{document.productVersion}</dd>
              <dt>Host</dt><dd>{document.host.state}</dd>
              <dt>Adoption</dt><dd>{document.adoption.state}</dd>
              <dt>Model</dt><dd>{document.model.state}</dd>
              <dt>Transcription</dt><dd>{document.transcription.state}</dd>
              <dt>Capabilities</dt><dd>{document.device.capabilities.length > 0 ? document.device.capabilities.join(", ") : "none"}</dd>
            </dl>
            <p className="connection-access">
              Available now: {[access.read ? "read" : null, access.converse ? "Ask" : null,
                access.voice ? "voice" : null, access.captureReplay ? "capture sync" : null,
                access.resolve ? "resolve" : null].filter((item) => item !== null).join(", ") || "local capture only"}.
            </p>
            {document.nextActions.length > 0 ? (
              <div className="connection-actions">
                <strong>Next actions</strong>
                <ul>{document.nextActions.map((action) => <li key={action.code}>{action.label}</li>)}</ul>
              </div>
            ) : <p>No host action is required.</p>}
          </>
        )}
      </div> : null}
    </section>
  );
}

export function AuthRepair({ control }: {
  control: NonNullable<HomeConnectionControl["authRepair"]>;
}): React.ReactElement {
  const [code, setCode] = useState("");
  return (
    <section className="availability-banner auth-repair" aria-labelledby="auth-repair-title">
      <strong id="auth-repair-title">Pair this device again</strong>
      <span>This device's authorization expired or was revoked. Local captures remain available.</span>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!control.pairing && code.trim().length > 0) control.pair(code);
      }}>
        <input
          aria-label="New pairing code"
          type="password"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="one-time-code"
          disabled={control.pairing}
        />
        <button type="submit" disabled={control.pairing || code.trim().length === 0}>
          {control.pairing ? "Pairing…" : "Pair again"}
        </button>
      </form>
      {control.error !== null ? <span role="alert">{control.error}</span> : null}
    </section>
  );
}
