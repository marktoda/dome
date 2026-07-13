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
