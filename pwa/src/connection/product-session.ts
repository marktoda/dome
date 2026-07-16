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
  label: "ready" | "limited" | "offline" | "unavailable" | "needs attention" | "checking";
  tone: "healthy" | "attention" | "unknown";
}>;

/**
 * The PWA's complete product contract. Callers consume one discriminant,
 * one feature-access value, and at most one recovery instead of interpreting
 * transport, readiness, provider, and authorization evidence independently.
 */
type SessionBase = Readonly<{
  document: ProductReadiness | null;
  access: ProductAccess;
  connection: ConnectionSummary;
  staleContext: boolean;
}>;

export type ProductSession =
  | Readonly<SessionBase & { kind: "current"; document: ProductReadiness; recovery: null }>
  | Readonly<SessionBase & {
    kind: "model-missing" | "model-unreachable" | "offline" | "unreachable" | "stale" | "incompatible" | "checking";
    recovery: RetryRecovery;
  }>
  | Readonly<SessionBase & { kind: "auth-repair"; recovery: RepairRecovery }>;

const NO_ACCESS: ProductAccess = Object.freeze({
  read: false,
  converse: false,
  voice: false,
  captureReplay: false,
  resolve: false,
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

function unavailable(
  kind: "offline" | "unreachable" | "stale" | "incompatible" | "checking",
  document: ProductReadiness | null,
  connection: ConnectionSummary,
  recovery: RetryRecovery,
): ProductSession {
  return Object.freeze({
    kind,
    document,
    access: NO_ACCESS,
    recovery,
    connection,
    staleContext: document !== null,
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
    });
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
    });
  }

  if (readiness.issue === "incompatible") {
    return unavailable("incompatible", readiness.document, {
      label: "needs attention", tone: "attention",
    }, {
      kind: "retry",
      title: "Dome Home needs an update",
      detail: "This app and Dome Home cannot work together yet. Update Dome Home, then check again.",
      actionLabel: "Check again",
    });
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
    });
  }

  if (readiness.document === null) {
    return unavailable("checking", null, {
      label: "checking", tone: "unknown",
    }, {
      kind: "retry",
      title: "Connecting to Dome Home",
      detail: "Live actions will return after the connection is checked. Text capture still works.",
      actionLabel: "Check connection",
    });
  }

  const document = readiness.document;
  const access = currentAccess(document);
  if (document.model.state === "unconfigured") {
    const session: ProductSession = {
      kind: "model-missing",
      document,
      access,
      recovery: {
        kind: "retry",
        title: "Ask needs setup",
        detail: "On your Mac, run dome home setup configure, then check again. Text capture and Today still work.",
        actionLabel: "Check again",
      },
      connection: { label: "limited", tone: "attention" },
      staleContext: false,
    };
    return Object.freeze(session);
  }
  if (document.model.state === "unreachable") {
    const session: ProductSession = {
      kind: "model-unreachable",
      document,
      access,
      recovery: {
        kind: "retry",
        title: "Ask is temporarily unavailable",
        detail: "Dome Home cannot reach the configured model. Text capture and Today still work.",
        actionLabel: "Try Ask again",
      },
      connection: { label: "limited", tone: "attention" },
      staleContext: false,
    };
    return Object.freeze(session);
  }

  const session: ProductSession = {
    kind: "current",
    document,
    access,
    recovery: null,
    connection: { label: "ready", tone: "healthy" },
    staleContext: false,
  };
  return Object.freeze(session);
}
