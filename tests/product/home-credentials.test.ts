import { describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOME_CREDENTIAL_SERVICE,
  HomeCredentialError,
  HomeCredentialMigrationRequiredError,
  assertHomeEnvironmentHasNoSecrets,
  isHomeSecretEnvironmentName,
  openHomeCredentialsForTests,
  type HomeCredentialCommandRunner,
} from "../../src/product-host/home-credentials";

const SLOT = "model.anthropic.api-key" as const;
const VAULT_ID = "vault-identity-1";

describe("Dome Home Keychain credentials", () => {
  test("parses real indented default-keychain output and names the exact Keychain in read-only operations", async () => {
    const fixture = await vaultFixture();
    const calls: Array<{ argv: readonly string[]; io: unknown }> = [];
    const run: HomeCredentialCommandRunner = async (argv, io) => {
      calls.push({ argv, io });
      if (argv.includes("default-keychain")) {
        return { exitCode: 0, stdout: `    ${JSON.stringify(keychainPath(fixture))}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    try {
      await openHomeCredentialsForTests({ platform: "darwin", run }).inspect(fixture, SLOT);
      expect(calls.at(-1)!.argv).toEqual([
        "/usr/bin/security", "find-generic-password", "-s", HOME_CREDENTIAL_SERVICE,
        "-a", `${VAULT_ID}:${SLOT}`, keychainPath(fixture),
      ]);
      expect(calls.some((call) => call.argv.includes("add-generic-password"))).toBeFalse();
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("reports presence and absence without returning account or secret material", async () => {
    const fixture = await vaultFixture();
    const statuses = [0, 44, 0, 44];
    const calls: string[][] = [];
    try {
      const credentials = openHomeCredentialsForTests({
        platform: "darwin",
        run: async (argv) => {
          calls.push([...argv]);
          if (argv.includes("default-keychain")) {
            return { exitCode: 0, stdout: `${JSON.stringify(keychainPath(fixture))}\n`, stderr: "" };
          }
          return { exitCode: statuses.shift()!, stdout: "", stderr: "" };
        },
      });
      expect(await credentials.inspect(fixture, SLOT)).toEqual({ present: true });
      expect(await credentials.inspect(fixture, SLOT)).toEqual({ present: false });
      expect(await credentials.remove(fixture, SLOT)).toEqual({ removed: true });
      expect(await credentials.remove(fixture, SLOT)).toEqual({ removed: false });
      expect(calls.find((argv) => argv.includes("find-generic-password"))).toEqual([
        "/usr/bin/security", "find-generic-password", "-s", HOME_CREDENTIAL_SERVICE,
        "-a", `${VAULT_ID}:${SLOT}`, keychainPath(fixture),
      ]);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("lends a secret to one callback but never returns it or preserves callback leak errors", async () => {
    const fixture = await vaultFixture();
    const secret = "  sk-ant-not-in-argv  ";
    const calls: string[][] = [];
    try {
      const credentials = openHomeCredentialsForTests({
        platform: "darwin",
        run: async (argv) => {
          calls.push([...argv]);
          if (argv.includes("default-keychain")) {
            return { exitCode: 0, stdout: `${JSON.stringify(keychainPath(fixture))}\n`, stderr: "" };
          }
          return { exitCode: 0, stdout: `${secret}\n`, stderr: "" };
        },
      });
      let observed = "";
      const returned = await credentials.withSecret(fixture, SLOT, async (value) => {
        observed = value;
        return value;
      });
      expect(observed).toBe(secret);
      expect(returned).toBeUndefined();
      expect(JSON.stringify(calls)).not.toContain(secret);
      const error = await credentials.withSecret(fixture, SLOT, async (value) => {
        throw new Error(`leaked ${value}`);
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HomeCredentialError);
      expect((error as Error).message).not.toContain(secret);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("distinguishes missing credentials and redacts bounded command failures", async () => {
    const fixture = await vaultFixture();
    try {
      const missing = openHomeCredentialsForTests({
        platform: "darwin",
        run: async (argv) => argv.includes("default-keychain")
          ? { exitCode: 0, stdout: `${JSON.stringify(keychainPath(fixture))}\n`, stderr: "" }
          : { exitCode: 44, stdout: "", stderr: "not found" },
      });
      const absent = await missing.withSecret(fixture, SLOT, async () => {}).catch((caught: unknown) => caught);
      expect(absent).toMatchObject({ code: "missing" });

      const account = `${VAULT_ID}:${SLOT}`;
      const failed = openHomeCredentialsForTests({
        platform: "darwin",
        run: async (argv) => argv.includes("default-keychain")
          ? { exitCode: 0, stdout: `${JSON.stringify(keychainPath(fixture))}\n`, stderr: "" }
          : { exitCode: 1, stdout: "", stderr: `${account} sk-ant-sensitive `.repeat(500) },
      });
      const failure = await failed.inspect(fixture, SLOT).catch((caught: unknown) => caught);
      expect(failure).toMatchObject({ code: "failed" });
      expect((failure as Error).message).not.toContain(account);
      expect((failure as Error).message).not.toContain("sk-ant-sensitive");
      expect((failure as Error).message.length).toBeLessThan(1100);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("distinguishes locked and denied Keychain failures", async () => {
    const fixture = await vaultFixture();
    try {
      for (const [exitCode, code] of [[36, "locked"], [51, "denied"]] as const) {
        const credentials = openHomeCredentialsForTests({
          platform: "darwin",
          run: async (argv) => argv.includes("default-keychain")
            ? { exitCode: 0, stdout: `${JSON.stringify(keychainPath(fixture))}\n`, stderr: "" }
            : { exitCode, stdout: "", stderr: "failure" },
        });
        await expect(credentials.inspect(fixture, SLOT)).rejects.toMatchObject({ code });
      }
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("requires a closed quoted default Keychain response", async () => {
    const fixture = await vaultFixture();
    try {
      for (const stdout of [`${keychainPath(fixture)}\n`, `${JSON.stringify(keychainPath(fixture))} trailing\n`]) {
        const credentials = openHomeCredentialsForTests({
          platform: "darwin",
          run: async () => ({ exitCode: 0, stdout, stderr: "" }),
        });
        await expect(credentials.inspect(fixture, SLOT)).rejects.toMatchObject({ code: "failed" });
      }
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("is darwin-only and refuses redirected or malformed vault identity", async () => {
    const fixture = await vaultFixture();
    try {
      const unsupported = openHomeCredentialsForTests({ platform: "linux", run: async () => {
        throw new Error("must not run");
      } });
      await expect(unsupported.inspect(fixture, SLOT)).rejects.toMatchObject({ code: "unsupported-platform" });
      await writeFile(join(fixture, ".dome", "state", "product-host-id"), "bad id!\n");
      await expect(openHomeCredentialsForTests({ platform: "darwin", run: async () => {
        throw new Error("must not run");
      } }).inspect(fixture, SLOT)).rejects.toThrow("malformed");
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("rejects linked, non-private, and path-swapped vault identity before any Keychain command", async () => {
    for (const fault of ["mode", "link", "symlink", "swap"] as const) {
      const fixture = await vaultFixture();
      const identity = join(fixture, ".dome", "state", "product-host-id");
      let calls = 0;
      try {
        if (fault === "mode") await chmod(identity, 0o644);
        if (fault === "link") await link(identity, join(fixture, "identity-alias"));
        if (fault === "symlink") {
          const outside = join(fixture, "outside-id");
          await writeFile(outside, `${VAULT_ID}\n`, { mode: 0o600 });
          await rm(identity);
          await symlink(outside, identity);
        }
        const credentials = openHomeCredentialsForTests({
          platform: "darwin",
          run: async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; },
          credentialIdentityReadCheckpoint: fault === "swap" ? async (path) => {
            await rename(path, `${path}.old`);
            await writeFile(path, `${VAULT_ID}\n`, { mode: 0o600 });
          } : undefined,
        });
        await expect(credentials.inspect(fixture, SLOT)).rejects.toThrow();
        expect(calls).toBe(0);
      } finally { await rm(fixture, { recursive: true, force: true }); }
    }
  });
});

describe("Home secret-persistence classifier", () => {
  test("recognizes provider names and conservative underscore-delimited secret suffixes", () => {
    for (const name of [
      "ANTHROPIC_API_KEY", "DOME_TRANSCRIBE_KEY", "OPENAI_API_KEY", "SERVICE_TOKEN",
      "A_SECRET", "DB_PASSWORD", "DB_PASSWD", "SSH_PRIVATE_KEY", "OAUTH_CLIENT_SECRET",
      "AWS_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "X_CREDENTIAL", "X_CREDENTIALS", "lower_api_key",
    ]) expect(isHomeSecretEnvironmentName(name)).toBeTrue();
    for (const name of [
      "PATH", "DOME_HOST", "TOKENIZER", "TOKEN_LIMIT", "PASSWORDLESS", "SECRETARY", "API_KEY_ID",
      "CREDENTIAL_MODE", "KEYCHAIN_PATH",
    ]) expect(isHomeSecretEnvironmentName(name)).toBeFalse();
  });

  test("throws the stable typed migration error", () => {
    expect(() => assertHomeEnvironmentHasNoSecrets([{ name: "SERVICE_TOKEN" }]))
      .toThrow(HomeCredentialMigrationRequiredError);
    try { assertHomeEnvironmentHasNoSecrets([{ name: "SERVICE_TOKEN" }]); }
    catch (error) { expect(error).toMatchObject({ code: "credential-migration-required" }); }
  });
});

async function vaultFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dome-home-credentials-"));
  await mkdir(join(root, ".dome", "state"), { recursive: true });
  await writeFile(join(root, ".dome", "state", "product-host-id"), `${VAULT_ID}\n`, { mode: 0o600 });
  await writeFile(keychainPath(root), "keychain fixture\n", { mode: 0o600 });
  return root;
}

function keychainPath(vault: string): string { return join(vault, "login.keychain-db"); }
