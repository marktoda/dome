import type { ProductReadiness } from "../../../contracts/product-readiness";

export type HomeAvailability = "available" | "offline" | "unreachable";

export type HomeReadinessEvidence = Readonly<{
  document: ProductReadiness | null;
  stale: boolean;
  issue: "readiness-failed" | "incompatible" | null;
}>;

export type ProductAccess = Readonly<{
  read: boolean;
  converse: boolean;
  voice: boolean;
  captureReplay: boolean;
  resolve: boolean;
}>;

type RetryRecovery = Readonly<{
  kind: "retry";
  title: string;
  detail: string;
  actionLabel: string;
}>;

type RepairRecovery = Readonly<{
  kind: "repair";
  title: "Pair this device again";
  detail: string;
}>;

export type ProductRecovery = RetryRecovery | RepairRecovery;

type ConnectionSummary = Readonly<{
  label: "ready" | "limited" | "offline" | "unavailable" | "needs attention" | "checking" | "syncing";
  tone: "healthy" | "attention" | "unknown";
}>;

export type ComposerPresentation = Readonly<{
  placeholder: "ask or capture…";
  hint: string | null;
}>;

export type OperationalPresentation = Readonly<{
  host: ProductReadiness["host"]["state"] | "unknown";
  adoption: ProductReadiness["adoption"]["state"] | "unknown";
  current: boolean;
}>;

export type ProductSessionKind =
  | "current"
  | "model-missing"
  | "model-unreachable"
  | "writes-paused"
  | "operational"
  | "offline"
  | "unreachable"
  | "stale"
  | "incompatible"
  | "checking"
  | "auth-repair";

/**
 * The PWA's complete product contract. Route admission and operational
 * presentation are deliberately independent: a validated route may remain
 * useful while the host is starting, degraded, or catching up, but only a
 * ready host at current adoption can produce the green `ready` summary.
 */
export type ProductSession = Readonly<{
  kind: ProductSessionKind;
  document: ProductReadiness | null;
  access: ProductAccess;
  connection: ConnectionSummary;
  operational: OperationalPresentation;
  composer: ComposerPresentation;
  recovery: ProductRecovery | null;
  staleContext: boolean;
}>;

const NO_ACCESS: ProductAccess = Object.freeze({
  read: false,
  converse: false,
  voice: false,
  captureReplay: false,
  resolve: false,
});

const UNKNOWN_OPERATIONAL: OperationalPresentation = Object.freeze({
  host: "unknown",
  adoption: "unknown",
  current: false,
});

function currentAccess(document: ProductReadiness): ProductAccess {
  const capabilities = new Set(document.device.capabilities);
  return Object.freeze({
    read: capabilities.has("read"),
    converse: capabilities.has("converse") && document.model.state === "ready",
    voice: capabilities.has("capture") && document.transcription.state === "ready",
    captureReplay: capabilities.has("capture") && document.writesAdmitted,
    resolve: capabilities.has("resolve") && document.writesAdmitted,
  });
}

function operationalPresentation(document: ProductReadiness): OperationalPresentation {
  return Object.freeze({
    host: document.host.state,
    adoption: document.adoption.state,
    current: document.host.state === "ready" && document.adoption.state === "current",
  });
}

function composerPresentation(
  document: ProductReadiness | null,
  access: ProductAccess,
  cause: "offline" | "unreachable" | "connection" | "auth" | null = null,
  recoveryVisible = false,
): ComposerPresentation {
  if (recoveryVisible) {
    return Object.freeze({
      placeholder: "ask or capture…",
      hint: null,
    });
  }
  if (cause === "offline" || cause === "unreachable" || cause === "connection") {
    return Object.freeze({
      placeholder: "ask or capture…",
      hint: "Ask and voice need a live Dome Home connection. Text capture stays on this device.",
    });
  }
  if (cause === "auth") {
    return Object.freeze({
      placeholder: "ask or capture…",
      hint: "Pair this device again to use Ask and voice. Text capture stays on this device.",
    });
  }
  if (document === null) {
    return Object.freeze({ placeholder: "ask or capture…", hint: null });
  }

  const capabilities = new Set(document.device.capabilities);
  const unavailable: string[] = [];
  if (!access.converse) {
    if (!capabilities.has("converse")) unavailable.push("Ask is not enabled for this device");
    else if (document.model.state === "unconfigured") unavailable.push("Ask needs model setup on your Mac");
    else unavailable.push("Ask cannot reach the configured model");
  }
  if (!access.voice) {
    if (!capabilities.has("capture")) unavailable.push("Voice is not enabled for this device");
    else if (document.transcription.state === "unconfigured") unavailable.push("Voice needs transcription setup on your Mac");
    else unavailable.push("Voice transcription is temporarily unavailable");
  }
  return Object.freeze({
    placeholder: "ask or capture…",
    hint: unavailable.length === 0 ? null : `${unavailable.join(". ")}. Text capture still works.`,
  });
}

function unavailable(
  kind: "offline" | "unreachable" | "stale" | "incompatible" | "checking",
  document: ProductReadiness | null,
  connection: ConnectionSummary,
  recovery: RetryRecovery,
  cause: "offline" | "unreachable" | "connection",
): ProductSession {
  return Object.freeze({
    kind,
    document,
    access: NO_ACCESS,
    recovery,
    connection,
    operational: document === null ? UNKNOWN_OPERATIONAL : operationalPresentation(document),
    composer: composerPresentation(document, NO_ACCESS, cause, true),
    staleContext: document !== null,
  });
}

type OperationalIssue = Readonly<{
  connection: ConnectionSummary;
  recovery: RetryRecovery;
}>;

function retry(title: string, detail: string, actionLabel = "Check again"): RetryRecovery {
  return Object.freeze({ kind: "retry", title, detail, actionLabel });
}

function issue(
  label: ConnectionSummary["label"],
  tone: ConnectionSummary["tone"],
  title: string,
  detail: string,
): OperationalIssue {
  return Object.freeze({ connection: { label, tone }, recovery: retry(title, detail) });
}

/** Select one recovery while `operational` preserves both underlying states. */
function operationalIssue(document: ProductReadiness): OperationalIssue | null {
  if (document.adoption.state === "diverged") return issue(
    "needs attention", "attention", "Dome's saved state has diverged",
    "On your Mac, run dome check and resolve the reported adoption issue before making changes.",
  );
  if (document.adoption.state === "blocked") return issue(
    "needs attention", "attention", "Dome could not finish updating your vault",
    "On your Mac, run dome check to see the blocking issue. Previously admitted reads remain available.",
  );
  if (document.host.state === "blocked") return issue(
    "needs attention", "attention", "Dome Home needs attention",
    "On your Mac, run dome home status to see what is blocking Dome Home.",
  );
  if (document.host.state === "starting") return issue(
    "checking", "unknown", "Dome Home is starting",
    "Available features remain usable while Dome Home finishes its startup checks.",
  );
  if (document.host.state === "probation") return issue(
    "checking", "unknown", "Dome Home is verifying this version",
    "Available features remain usable while Dome Home completes its safety checks.",
  );
  if (document.host.state === "degraded") return issue(
    "limited", "attention", "Dome Home is running with limits",
    "On your Mac, run dome home status for the current issue. Available features remain usable.",
  );
  if (document.adoption.state === "pending") return issue(
    "syncing", "unknown", "Dome is catching up",
    "Available features remain usable while recent vault changes are adopted.",
  );
  if (document.adoption.state === "unknown") return issue(
    "needs attention", "attention", "Dome cannot confirm the current vault state",
    "On your Mac, run dome check to inspect adoption state before making changes.",
  );
  return null;
}

function liveSession(
  kind: ProductSessionKind,
  document: ProductReadiness,
  access: ProductAccess,
  connection: ConnectionSummary,
  recovery: ProductRecovery | null,
): ProductSession {
  return Object.freeze({
    kind,
    document,
    access,
    connection,
    operational: operationalPresentation(document),
    composer: composerPresentation(document, access, null, recovery !== null),
    recovery,
    staleContext: false,
  });
}

/** Pure, total derivation of the PWA experience from validated connection evidence. */
export function deriveProductSession(input: Readonly<{
  availability: HomeAvailability;
  readiness: HomeReadinessEvidence;
  authRepair: boolean;
}>): ProductSession {
  const { availability, readiness } = input;

  // Authorization loss is the most specific recovery. It wins even when the
  // last request also made the transport/readiness evidence stale.
  if (input.authRepair) {
    const session: ProductSession = {
      kind: "auth-repair",
      document: readiness.document,
      access: NO_ACCESS,
      recovery: {
        kind: "repair",
        title: "Pair this device again",
        detail: "This device's access expired or was revoked. Text captures remain available here.",
      },
      connection: { label: "needs attention", tone: "attention" },
      operational: readiness.document === null ? UNKNOWN_OPERATIONAL : operationalPresentation(readiness.document),
      composer: composerPresentation(readiness.document, NO_ACCESS, "auth", true),
      staleContext: readiness.document !== null,
    };
    return Object.freeze(session);
  }

  if (availability === "offline") {
    return unavailable("offline", readiness.document, {
      label: "offline", tone: "attention",
    }, {
      kind: "retry",
      title: "You're offline",
      detail: readiness.document === null
        ? "Live information is unavailable. Text captures stay on this device."
        : "Showing the last loaded information. Text captures stay on this device.",
      actionLabel: "Try again",
    }, "offline");
  }

  if (availability === "unreachable") {
    return unavailable("unreachable", readiness.document, {
      label: "unavailable", tone: "attention",
    }, {
      kind: "retry",
      title: "Dome Home can't be reached",
      detail: readiness.document === null
        ? "Live information is unavailable. Text captures stay on this device."
        : "Showing the last loaded information. Text captures stay on this device.",
      actionLabel: "Try again",
    }, "unreachable");
  }

  if (readiness.issue === "incompatible") {
    return unavailable("incompatible", readiness.document, {
      label: "needs attention", tone: "attention",
    }, {
      kind: "retry",
      title: "Dome Home needs an update",
      detail: "This app and Dome Home cannot work together yet. Update Dome Home, then check again.",
      actionLabel: "Check again",
    }, "connection");
  }

  if (readiness.issue === "readiness-failed" || readiness.stale) {
    return unavailable("stale", readiness.document, {
      label: "needs attention", tone: "attention",
    }, {
      kind: "retry",
      title: "Connection needs a refresh",
      detail: readiness.document === null
        ? "Live actions are paused until Dome Home responds. Text capture still works."
        : "Showing the last loaded information. Live actions are paused until the connection is refreshed.",
      actionLabel: "Refresh connection",
    }, "connection");
  }

  if (readiness.document === null) {
    return unavailable("checking", null, {
      label: "checking", tone: "unknown",
    }, {
      kind: "retry",
      title: "Connecting to Dome Home",
      detail: "Live actions will return after the connection is checked. Text capture still works.",
      actionLabel: "Check connection",
    }, "connection");
  }

  const document = readiness.document;
  const access = currentAccess(document);
  const issue = operationalIssue(document);
  if (issue !== null) return liveSession("operational", document, access, issue.connection, issue.recovery);

  if (!document.writesAdmitted) {
    return liveSession("writes-paused", document, access, { label: "limited", tone: "attention" }, retry(
      "Dome Home is not accepting changes",
      "On your Mac, run dome home status for the current write-admission issue. Text capture stays on this device.",
    ));
  }
  if (document.model.state === "unconfigured") {
    return liveSession("model-missing", document, access, { label: "limited", tone: "attention" }, retry(
      "Ask needs setup",
      "On your Mac, run dome home setup configure, then check again. Text capture and Today still work.",
    ));
  }
  if (document.model.state === "unreachable") {
    return liveSession("model-unreachable", document, access, { label: "limited", tone: "attention" }, retry(
      "Ask is temporarily unavailable",
      "Dome Home cannot reach the configured model. Text capture and Today still work.",
      "Try Ask again",
    ));
  }

  return liveSession("current", document, access, { label: "ready", tone: "healthy" }, null);
}
