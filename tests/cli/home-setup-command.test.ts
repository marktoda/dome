import { afterEach, beforeEach, expect, test } from "bun:test";

import { runHomeSetup } from "../../src/cli/commands/home-setup";
import type { HomeCredentials } from "../../src/product-host/home-credentials";
import type { HomeModelRuntime } from "../../src/product-host/home-model-provider";

let logs: string[] = [];
let errors: string[] = [];
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...parts: unknown[]) => logs.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

test("home setup CLI renders model-only derived status and fixed next command", async () => {
  expect(await runHomeSetup("status", { vault: "/vault" }, {
    credentials: credentials(),
    resolveModel: async () => runtime("missing", "unconfigured"),
    inspectResidue: async () => cleanResidue(),
  })).toBe(1);
  expect(errors.join("\n")).toContain("model credential: missing");
  expect(errors.join("\n")).toContain("next: dome home setup configure");
  expect(errors.join("\n")).not.toContain("transcription");
});

test("home setup CLI JSON emits only the public setup document", async () => {
  const states = [runtime("missing", "unconfigured"), runtime("present", "ready")];
  expect(await runHomeSetup("configure", { vault: "/vault", json: true }, {
    credentials: credentials(),
    resolveModel: async () => states.shift()!,
    inspectResidue: async () => cleanResidue(),
  })).toBe(0);
  const result = JSON.parse(logs.at(-1) ?? "{}") as Record<string, unknown>;
  expect(result).toMatchObject({ schema: "dome.home.setup/v1", action: "configure", status: "configured" });
  expect(JSON.stringify(result)).not.toMatch(/api[_-]?key|secret/i);
  expect(errors).toEqual([]);
});

function credentials(): HomeCredentials {
  return {
    inspect: async () => ({ present: true }),
    configure: async () => {},
    check: async () => ({ present: true }),
    remove: async () => ({ removed: true }),
    modelProviderCommand: async () => ["/helper", "run-model-provider", "/vault"],
  };
}

function runtime(credential: HomeModelRuntime["credential"], modelState: HomeModelRuntime["modelState"]): HomeModelRuntime {
  return { configuration: "shipped-anthropic", credential, modelState, probe: null, detail: null };
}

function cleanResidue() {
  return {
    schema: "dome.home.credential-residue/v1" as const,
    atRest: true as const,
    runtime: "unknown" as const,
    state: "clean" as const,
    findings: Object.freeze([]),
  };
}
