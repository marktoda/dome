export const PRODUCT_READINESS_SCHEMA = "dome.product.readiness/v1" as const;

export type ProductReadiness = {
  readonly schema: typeof PRODUCT_READINESS_SCHEMA;
  readonly productVersion: string;
  readonly artifactId: string;
  readonly writesAdmitted: boolean;
  readonly contractVersions: ReadonlyArray<string>;
  readonly assetVersion: string;
  readonly vault: { readonly id: string; readonly name: string };
  readonly device: {
    readonly id: string;
    readonly name: string;
    readonly capabilities: ReadonlyArray<string>;
  };
  readonly host: {
    readonly state: "starting" | "ready" | "degraded" | "blocked" | "probation";
    readonly since: string;
  };
  readonly adoption: {
    readonly state: "current" | "pending" | "blocked" | "diverged" | "unknown";
    readonly head: string | null;
    readonly adopted: string | null;
    readonly lastSuccessAt: string | null;
  };
  readonly model: { readonly state: "ready" | "unconfigured" | "unreachable" };
  readonly transcription: { readonly state: "ready" | "unconfigured" | "unreachable" };
  readonly nextActions: ReadonlyArray<{ readonly code: string; readonly label: string }>;
};

/** Strict runtime parser shared by candidate validation and protocol adapters. */
export function parseProductReadiness(value: unknown): ProductReadiness {
  const root = exactRecord(value, [
    "schema", "productVersion", "artifactId", "writesAdmitted", "contractVersions",
    "assetVersion", "vault", "device", "host", "adoption", "model", "transcription",
    "nextActions",
  ]);
  const vault = exactRecord(root["vault"], ["id", "name"]);
  const device = exactRecord(root["device"], ["id", "name", "capabilities"]);
  const host = exactRecord(root["host"], ["state", "since"]);
  const adoption = exactRecord(root["adoption"], ["state", "head", "adopted", "lastSuccessAt"]);
  const model = exactRecord(root["model"], ["state"]);
  const transcription = exactRecord(root["transcription"], ["state"]);
  if (!Array.isArray(root["nextActions"])) invalid();
  const actions = root["nextActions"].map((action) => exactRecord(action, ["code", "label"]));
  if (root["schema"] !== PRODUCT_READINESS_SCHEMA || !boundedText(root["productVersion"]) ||
    !boundedText(root["artifactId"]) || typeof root["writesAdmitted"] !== "boolean" ||
    !Array.isArray(root["contractVersions"]) || !root["contractVersions"].every(boundedText) ||
    !boundedText(root["assetVersion"]) || !boundedText(vault["id"]) || !boundedText(vault["name"]) ||
    !boundedText(device["id"]) || !boundedText(device["name"]) ||
    !Array.isArray(device["capabilities"]) || !device["capabilities"].every(boundedText) ||
    !["starting", "ready", "degraded", "blocked", "probation"].includes(host["state"] as string) ||
    !exactTimestamp(host["since"]) ||
    !["current", "pending", "blocked", "diverged", "unknown"].includes(adoption["state"] as string) ||
    !nullableText(adoption["head"]) || !nullableText(adoption["adopted"]) ||
    !(adoption["lastSuccessAt"] === null || exactTimestamp(adoption["lastSuccessAt"])) ||
    !["ready", "unconfigured", "unreachable"].includes(model["state"] as string) ||
    !["ready", "unconfigured", "unreachable"].includes(transcription["state"] as string) ||
    actions.some((action) => !boundedText(action["code"]) || !boundedText(action["label"]))) invalid();
  return value as ProductReadiness;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) invalid();
  return record;
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !value.includes("\0") && !/[\r\n]/.test(value);
}

function nullableText(value: unknown): boolean { return value === null || boundedText(value); }

function exactTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function invalid(): never { throw new Error("invalid dome.product.readiness/v1 document"); }
