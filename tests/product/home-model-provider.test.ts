import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HomeCredentialError, type HomeCredentials } from "../../src/product-host/home-credentials";
import { resolveHomeModelRuntime, scrubbedProviderEnvironment } from "../../src/product-host/home-model-provider";

describe("Home model-provider resolution", () => {
  test("replaces only the exact shipped command with the fixed helper command", async () => {
    const vault = await fixture('["bun", ".dome/model-provider.ts"]');
    const probes: unknown[] = [];
    try {
      await writeFile(join(vault, ".dome", "model-provider.ts"), "throw new Error('mutable provider must not run');\n");
      const resolved = await resolveHomeModelRuntime(vault, {
        credentials: credentials(true),
        sourceEnvironment: { HOME: "/Users/test", TMPDIR: "/tmp/test", ANTHROPIC_MODEL: "claude-test",
          ANTHROPIC_API_KEY: "must-not-cross", ANTHROPIC_BASE_URL: "https://evil.invalid",
          UNRELATED_SETTING: "must-not-cross" },
        probe: async (config, opts) => {
          probes.push({ config, opts });
          return { status: "responsive", provider: "anthropic", keyPresent: true };
        },
      });
      expect(resolved).toMatchObject({
        configuration: "shipped-anthropic", credential: "present", modelState: "ready",
      });
      expect(probes).toEqual([{ config: {
        kind: "command", command: ["/artifact/runtime/dome-keychain-helper", "run-model-provider", vault],
      }, opts: { cwd: vault, env: { HOME: "/Users/test", PATH: "/usr/bin:/bin", TMPDIR: "/tmp/test",
        ANTHROPIC_MODEL: "claude-test" } } }]);
      expect(JSON.stringify(probes)).not.toContain("must-not-cross");
      expect(JSON.stringify(probes)).not.toContain("evil.invalid");
      expect(JSON.stringify(probes)).not.toContain(".dome/model-provider.ts");
    } finally { await rm(vault, { recursive: true, force: true }); }
  });

  test("does not launch or override the shipped provider when its credential is absent", async () => {
    const vault = await fixture('["bun", ".dome/model-provider.ts"]');
    let probes = 0;
    try {
      const resolved = await resolveHomeModelRuntime(vault, {
        credentials: credentials(false),
        probe: async () => { probes += 1; return { status: "responsive" }; },
      });
      expect(resolved).toMatchObject({
        configuration: "shipped-anthropic", credential: "missing", modelState: "unconfigured",
      });
      expect(resolved.modelProvider).toBeFunction();
      expect(probes).toBe(0);
    } finally { await rm(vault, { recursive: true, force: true }); }
  });

  test("preserves helper exit taxonomy when Keychain truth changes after preflight", async () => {
    const vault = await fixture('["bun", ".dome/model-provider.ts"]');
    try {
      for (const [exitCode, credential, modelState] of [
        [44, "missing", "unconfigured"], [5, "locked", "unreachable"],
        [3, "denied", "unreachable"], [4, "unavailable", "unreachable"],
      ] as const) {
        const resolved = await resolveHomeModelRuntime(vault, {
          credentials: credentials(true),
          probe: async () => ({ status: "probe-unsupported", exitCode, detail: "fixed helper failure" }),
        });
        expect(resolved).toMatchObject({ configuration: "shipped-anthropic", credential, modelState });
        expect(resolved.modelProvider).toBeFunction();
      }
    } finally { await rm(vault, { recursive: true, force: true }); }
  });

  test("single-flights concurrent readiness checks and refreshes after the one-second cache expires", async () => {
    const vault = await fixture('["bun", ".dome/model-provider.ts"]');
    let credential: "present" | "missing" = "present";
    let probes = 0;
    let checks = 0;
    let releaseCheck: (() => void) | undefined;
    const liveCredentials: HomeCredentials = {
      inspect: async () => ({ present: credential !== "missing" }),
      configure: async () => {},
      check: async () => {
        checks += 1;
        if (releaseCheck !== undefined) {
          await new Promise<void>((resolve) => { releaseCheck = resolve; });
        }
        if (credential === "missing") throw new HomeCredentialError("missing", "missing");
        return { present: true };
      },
      remove: async () => ({ removed: true }),
      modelProviderCommand: async (path) => ["/artifact/runtime/dome-keychain-helper", "run-model-provider", path],
    };
    try {
      const resolved = await resolveHomeModelRuntime(vault, {
        credentials: liveCredentials,
        probe: async () => { probes += 1; return { status: "responsive", keyPresent: true }; },
      });
      expect(resolved.modelStateResolver).toBeFunction();
      expect(checks).toBe(1);
      releaseCheck = () => {};
      const simultaneous = Array.from({ length: 20 }, () => resolved.modelStateResolver!());
      await Bun.sleep(10);
      expect(checks).toBe(2);
      const release = releaseCheck;
      releaseCheck = undefined;
      release!();
      expect(await Promise.all(simultaneous)).toEqual(Array(20).fill("ready"));
      expect(await resolved.modelStateResolver!()).toBe("ready");
      expect(checks).toBe(2);
      credential = "missing";
      await Bun.sleep(1_010);
      expect(await resolved.modelStateResolver!()).toBe("unconfigured");
      expect(checks).toBe(3);
      expect(probes).toBe(1);
    } finally { await rm(vault, { recursive: true, force: true }); }
  });

  test("preserves custom commands but probes and runs them with only scrubbed environment", async () => {
    const vault = await fixture('["/opt/custom-provider"]');
    try {
      const environment = scrubbedProviderEnvironment({
        HOME: "/Users/test", PATH: "/custom/bin", TMPDIR: "/tmp/test", LANG: "en_US.UTF-8",
        ANTHROPIC_API_KEY: "must-not-cross", DOME_SECRET: "must-not-cross",
      });
      const resolved = await resolveHomeModelRuntime(vault, {
        credentials: credentials(true), environment,
        probe: async (config, opts) => {
          expect(config.command).toEqual(["/opt/custom-provider"]);
          expect(opts?.env).toEqual({ HOME: "/Users/test", PATH: "/custom/bin", TMPDIR: "/tmp/test", LANG: "en_US.UTF-8" });
          expect(JSON.stringify(opts?.env)).not.toContain("must-not-cross");
          return { status: "probe-unsupported", exitCode: 2, detail: "legacy custom provider" };
        },
      });
      expect(resolved).toMatchObject({ configuration: "custom", credential: "not-managed", modelState: "ready" });
      expect(resolved.modelProvider).toBeFunction();
    } finally { await rm(vault, { recursive: true, force: true }); }
  });
});

function credentials(present: boolean): HomeCredentials {
  return {
    inspect: async () => ({ present }),
    configure: async () => {},
    check: async () => ({ present }),
    remove: async () => ({ removed: present }),
    modelProviderCommand: async (vault) => [
      "/artifact/runtime/dome-keychain-helper", "run-model-provider", vault,
    ],
  };
}

async function fixture(command: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dome-home-model-"));
  await mkdir(join(root, ".dome"), { recursive: true });
  await writeFile(join(root, ".dome", "config.yaml"), `model_provider:\n  kind: command\n  command: ${command}\nextensions: {}\n`);
  return root;
}
