import { describe, expect, test } from "bun:test";

import { type HomeCredentials } from "../../src/product-host/home-credentials";
import type { HomeModelRuntime } from "../../src/product-host/home-model-provider";
import { manageHomeSetup } from "../../src/product-host/home-setup";

const cleanResidue = Object.freeze({
  schema: "dome.home.credential-residue/v1" as const,
  atRest: true as const,
  runtime: "unknown" as const,
  state: "clean" as const,
  findings: Object.freeze([]),
});

describe("guided Dome Home model setup", () => {
  test("derives readiness from exact config, credential, provider probe, and residue", async () => {
    const ready = await manageHomeSetup({ action: "status", vaultPath: "/vault" }, {
      credentials: fakeCredentials(),
      resolveModel: async () => runtime("shipped-anthropic", "present", "ready"),
      inspectResidue: async () => cleanResidue,
    });
    expect(ready).toEqual({
      schema: "dome.home.setup/v1", action: "status", status: "ready", exitCode: 0,
      model: { configuration: "shipped-anthropic", credential: "present", runtime: "ready" },
      residue: cleanResidue, nextAction: "none", message: "Dome Home model setup is ready",
    });

    const missing = await manageHomeSetup({ action: "status", vaultPath: "/vault" }, {
      credentials: fakeCredentials(),
      resolveModel: async () => runtime("shipped-anthropic", "missing", "unconfigured"),
      inspectResidue: async () => cleanResidue,
    });
    expect(missing).toMatchObject({ status: "incomplete", exitCode: 1, nextAction: "configure-model" });

    const locked = await manageHomeSetup({ action: "status", vaultPath: "/vault" }, {
      credentials: fakeCredentials(),
      resolveModel: async () => runtime("shipped-anthropic", "locked", "unreachable"),
      inspectResidue: async () => cleanResidue,
    });
    expect(locked).toMatchObject({ status: "incomplete", exitCode: 1, nextAction: "unlock-keychain" });
  });

  test("configure verifies through the same provider probe path", async () => {
    const calls: string[] = [];
    const states = [
      runtime("shipped-anthropic", "missing", "unconfigured"),
      runtime("shipped-anthropic", "present", "ready"),
    ];
    const result = await manageHomeSetup({ action: "configure", vaultPath: "/vault" }, {
      credentials: fakeCredentials(calls),
      resolveModel: async () => states.shift()!,
      inspectResidue: async () => cleanResidue,
    });
    expect(result).toMatchObject({ status: "configured", exitCode: 0, nextAction: "none" });
    expect(calls).toEqual(["configure"]);
    expect(JSON.stringify(result)).not.toMatch(/api[_-]?key|provider-secret/i);
  });

  test("configure success still derives the next action from plaintext residue", async () => {
    const states = [
      runtime("shipped-anthropic", "missing", "unconfigured"),
      runtime("shipped-anthropic", "present", "ready"),
    ];
    const residue = { ...cleanResidue, state: "residue" as const, findings: Object.freeze([
      { surface: "live" as const, document: "plist" as const, variableName: "ANTHROPIC_API_KEY" },
    ]) };
    const result = await manageHomeSetup({ action: "configure", vaultPath: "/vault" }, {
      credentials: fakeCredentials(), resolveModel: async () => states.shift()!,
      inspectResidue: async () => residue,
    });
    expect(result).toMatchObject({ status: "configured", exitCode: 0, nextAction: "inspect-credential-residue" });
  });

  test("preserves missing, custom, and invalid provider configuration without writing a key", async () => {
    for (const configuration of ["missing", "custom", "invalid"] as const) {
      const calls: string[] = [];
      const result = await manageHomeSetup({ action: "configure", vaultPath: "/vault" }, {
        credentials: fakeCredentials(calls),
        resolveModel: async () => runtime(configuration, "not-managed", "unconfigured"),
        inspectResidue: async () => cleanResidue,
      });
      expect(result).toMatchObject({ status: "error", exitCode: 64,
        nextAction: configuration === "missing" ? "initialize-model-provider" : "configure-model-provider" });
      expect(calls).toEqual([]);
    }
  });

  test("remove documents live rotation and subsequent missing launches", async () => {
    const calls: string[] = [];
    const states = [
      runtime("shipped-anthropic", "present", "ready"),
      runtime("shipped-anthropic", "missing", "unconfigured"),
    ];
    const result = await manageHomeSetup({ action: "remove", vaultPath: "/vault" }, {
      credentials: fakeCredentials(calls),
      resolveModel: async () => states.shift()!,
      inspectResidue: async () => cleanResidue,
    });
    expect(result).toMatchObject({ status: "removed", exitCode: 0, nextAction: "configure-model" });
    expect(result.message).toContain("subsequent provider launches");
    expect(calls).toEqual(["remove"]);
  });
});

function fakeCredentials(calls: string[] = []): HomeCredentials {
  return {
    inspect: async () => ({ present: true }),
    configure: async () => { calls.push("configure"); },
    check: async () => ({ present: true }),
    remove: async () => { calls.push("remove"); return { removed: true }; },
    modelProviderCommand: async () => ["/helper", "run-model-provider", "/vault"],
  };
}

function runtime(
  configuration: HomeModelRuntime["configuration"],
  credential: HomeModelRuntime["credential"],
  modelState: HomeModelRuntime["modelState"],
): HomeModelRuntime {
  return Object.freeze({ configuration, credential, modelState, probe: null, detail: null });
}
