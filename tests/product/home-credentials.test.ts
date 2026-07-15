import { describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HomeCredentialError,
  HomeCredentialMigrationRequiredError,
  assertHomeEnvironmentHasNoSecrets,
  isHomeSecretEnvironmentName,
  openHomeCredentialsForTests,
  runHomeCredentialHelper,
} from "../../src/product-host/home-credentials";

describe("Dome Home native Keychain credentials", () => {
  test("a copied vault id cannot alias the original vault's credential account", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "native", "home-keychain-helper.c"), "utf8");
    expect(source).toContain('sha256_hex(vault, strlen(vault), vault_hash)');
    expect(source).toContain('"%s:%s:%s", vault_id, SLOT, vault_hash');
    expect(source).not.toContain('"%s:%s", vault_id, SLOT');
  });

  test("native design binds managed execution to the immutable packaged Bun and provider", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "native", "home-keychain-helper.c"), "utf8");
    expect(source).toContain('PROVIDER_RELATIVE "app/assets/model-providers/anthropic.ts"');
    expect(source).toContain("SHIPPED_PROVIDER_SHA256");
    expect(source).toContain("SHIPPED_BUN_SHA256");
    expect(source).toContain("strcmp(hex, SHIPPED_BUN_SHA256) == 0");
    expect(source).toContain("S_ISREG(before.st_mode) && before.st_uid == getuid()");
    expect(source).toContain("before.st_nlink == 1 && (before.st_mode & 0022) == 0 && (before.st_mode & 0111) != 0");
    expect(source).toContain("exec_reproved_named_inode");
    expect(source).toContain('"/dev/fd/%d"');
    expect(source).not.toContain('"ANTHROPIC_BASE_URL"');
  });

  test("native provider launch zeroizes allocation capacity and makes exec the only work after final proof", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "native", "home-keychain-helper.c"), "utf8");
    const launch = source.slice(source.indexOf("static int model_provider_exec("), source.indexOf("int main("));
    expect(launch).toContain("size_t credential_capacity = 0;");
    expect(launch).toContain("explicit_bzero(credential, credential_capacity);");
    expect(launch).not.toContain("strlen(credential)");

    const cleanup = launch.lastIndexOf("CFRelease(keychain);");
    const argvAssembly = launch.indexOf("char *const child_argv[]");
    const chdir = launch.indexOf("if (chdir(vault) != 0)");
    const finalProof = launch.indexOf("exec_reproved_named_inode(", chdir);
    expect(cleanup).toBeGreaterThan(-1);
    expect(argvAssembly).toBeGreaterThan(cleanup);
    expect(chdir).toBeGreaterThan(argvAssembly);
    expect(finalProof).toBeGreaterThan(chdir);

    const proofStart = source.indexOf("static int exec_reproved_named_inode(");
    const proof = source.slice(proofStart, source.indexOf("static int direct_owned(", proofStart));
    expect(proof).toContain("fstat(fd, &held) == 0 && lstat(path, &named) == 0");
    expect(proof).toMatch(/same_file\(identity, &named\)\) \{[\s\S]*return execve\(path, argv, env\);/);
  });

  test("successful but invalid Keychain payloads are wiped and mapped to generic exit 4", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "native", "home-keychain-helper.c"), "utf8");
    const check = source.slice(source.indexOf('if (strcmp(argv[1], "check") == 0)'), source.indexOf("char secret[SECRET_CAPACITY]"));
    expect(check).toContain("status = errSecDecode;");
    expect(check).toContain("if (password_data != NULL) {");
    expect(check).toContain('fail("Dome Home credential check failed", code)');
    expect(source).toContain("if (status == errSecSuccess) return 0;");
    expect(source).toContain("return 4;");
  });

  test("disables Keychain UI only before decrypting check and provider access", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "native", "home-keychain-helper.c"), "utf8");
    expect(source.match(/SecKeychainSetUserInteractionAllowed\(false\)/g)).toHaveLength(2);
    const main = source.slice(source.indexOf("int main("));
    const openKeychain = main.indexOf("open_bound_keychain(&keychain)");
    const runMode = main.indexOf('if (strcmp(argv[1], "run-model-provider") == 0) {');
    const checkMode = main.indexOf('else if (strcmp(argv[1], "check") == 0) {');
    const runDisable = main.indexOf("SecKeychainSetUserInteractionAllowed(false)", runMode);
    const checkDisable = main.indexOf("SecKeychainSetUserInteractionAllowed(false)", checkMode);
    expect(runMode).toBeLessThan(runDisable);
    expect(runDisable).toBeLessThan(openKeychain);
    expect(checkMode).toBeLessThan(checkDisable);
    expect(checkDisable).toBeLessThan(openKeychain);
  });
  test("uses only the closed helper operation and canonical vault argv", async () => {
    const fixture = await vaultFixture();
    const calls: string[][] = [];
    const timeoutOptions: Array<number | undefined> = [];
    const statuses = [0, 44, 0, 0, 0, 0, 44];
    try {
      const credentials = openHomeCredentialsForTests({
        platform: "darwin",
        helperPath: helperPath(fixture),
        runHelper: async (argv, options) => {
          calls.push([...argv]);
          timeoutOptions.push(options?.timeoutMs);
          return { exitCode: statuses.shift()! };
        },
      });
      expect(await credentials.inspect(fixture)).toEqual({ present: true });
      expect(await credentials.inspect(fixture)).toEqual({ present: false });
      await credentials.configure(fixture);
      expect(await credentials.check(fixture)).toEqual({ present: true });
      expect(await credentials.remove(fixture)).toEqual({ removed: true });
      expect(await credentials.remove(fixture)).toEqual({ removed: false });
      expect(await credentials.modelProviderCommand(fixture)).toEqual([
        helperPath(fixture), "run-model-provider", fixture,
      ]);
      expect(calls).toEqual([
        "inspect", "inspect", "replace", "check", "check", "remove", "remove",
      ].map((operation) => [helperPath(fixture), operation, fixture]));
      expect(timeoutOptions).toEqual([1_000, 1_000, undefined, 1_000, 1_000, 1_000, 1_000]);
      expect(JSON.stringify(calls)).not.toMatch(/api[_-]?key|secret|anthropic/i);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("maps helper outcomes without exposing helper diagnostics", async () => {
    const fixture = await vaultFixture();
    try {
      for (const [exitCode, code] of [[44, "missing"], [3, "denied"], [5, "locked"], [4, "failed"]] as const) {
        const credentials = openHomeCredentialsForTests({
          platform: "darwin", helperPath: helperPath(fixture),
          runHelper: async () => ({ exitCode }),
        });
        const error = await credentials.check(fixture).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HomeCredentialError);
        expect(error).toMatchObject({ code });
        expect((error as Error).message).not.toContain(fixture);
      }
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("rejects linked, writable, or redirected helpers before execution", async () => {
    for (const fault of ["linked", "writable", "redirected"] as const) {
      const fixture = await vaultFixture();
      let calls = 0;
      try {
        if (fault === "linked") await link(helperPath(fixture), join(fixture, "helper-alias"));
        if (fault === "writable") await chmod(helperPath(fixture), 0o777);
        if (fault === "redirected") {
          const outside = join(fixture, "outside-helper");
          await writeFile(outside, "helper", { mode: 0o755 });
          await rm(helperPath(fixture));
          await symlink(outside, helperPath(fixture));
        }
        const credentials = openHomeCredentialsForTests({
          platform: "darwin", helperPath: helperPath(fixture),
          runHelper: async () => { calls += 1; return { exitCode: 0 }; },
        });
        await expect(credentials.inspect(fixture)).rejects.toMatchObject({ code: "failed" });
        expect(calls).toBe(0);
      } finally { await rm(fixture, { recursive: true, force: true }); }
    }
  });

  test("serializes configure and remove while provider launches remain independent", async () => {
    const fixture = await vaultFixture();
    const events: string[] = [];
    let releaseReplace!: () => void;
    const replaceGate = new Promise<void>((resolve) => { releaseReplace = resolve; });
    try {
      const credentials = openHomeCredentialsForTests({
        platform: "darwin", helperPath: helperPath(fixture),
        runHelper: async (argv) => {
          events.push(`${argv[1]}:start`);
          if (argv[1] === "replace") await replaceGate;
          events.push(`${argv[1]}:end`);
          return { exitCode: 0 };
        },
      });
      const configuring = credentials.configure(fixture);
      await Bun.sleep(5);
      const removing = credentials.remove(fixture);
      expect(await credentials.modelProviderCommand(fixture)).toEqual([
        helperPath(fixture), "run-model-provider", fixture,
      ]);
      expect(events).toEqual(["replace:start"]);
      releaseReplace();
      await Promise.all([configuring, removing]);
      expect(events).toEqual([
        "replace:start", "replace:end", "check:start", "check:end", "remove:start", "remove:end",
      ]);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("kills and reports a hung credential helper within the configured bound", async () => {
    const fixture = await vaultFixture();
    try {
      await writeFile(helperPath(fixture), "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
      const credentials = openHomeCredentialsForTests({
        platform: "darwin", helperPath: helperPath(fixture), helperTimeoutMs: 25,
      });
      const started = performance.now();
      await expect(credentials.check(fixture)).rejects.toMatchObject({ code: "failed" });
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("the helper runner seam hard-kills a hung child at its explicit timeout", async () => {
    const fixture = await vaultFixture();
    try {
      await writeFile(helperPath(fixture), "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
      const started = performance.now();
      await expect(runHomeCredentialHelper([helperPath(fixture)], { timeoutMs: 25 })).rejects.toThrow("exceeded 25ms");
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  test("is darwin-only before invoking the helper", async () => {
    let calls = 0;
    const credentials = openHomeCredentialsForTests({
      platform: "linux", runHelper: async () => { calls += 1; return { exitCode: 0 }; },
    });
    await expect(credentials.inspect("/tmp")).rejects.toMatchObject({ code: "unsupported-platform" });
    expect(calls).toBe(0);
  });
});

describe("Home secret-persistence classifier", () => {
  test("recognizes conservative secret suffixes without broad false positives", () => {
    for (const name of [
      "ANTHROPIC_API_KEY", "DOME_TRANSCRIBE_KEY", "OPENAI_API_KEY", "SERVICE_TOKEN",
      "A_SECRET", "DB_PASSWORD", "SSH_PRIVATE_KEY", "OAUTH_CLIENT_SECRET", "lower_api_key",
    ]) expect(isHomeSecretEnvironmentName(name)).toBeTrue();
    for (const name of ["PATH", "TOKENIZER", "TOKEN_LIMIT", "PASSWORDLESS", "API_KEY_ID", "KEYCHAIN_PATH"])
      expect(isHomeSecretEnvironmentName(name)).toBeFalse();
  });

  test("throws the stable typed migration error", () => {
    expect(() => assertHomeEnvironmentHasNoSecrets([{ name: "SERVICE_TOKEN" }]))
      .toThrow(HomeCredentialMigrationRequiredError);
  });
});

async function vaultFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dome-home-credentials-"));
  await writeFile(helperPath(root), "native helper fixture\n", { mode: 0o755 });
  return await realpath(root);
}

function helperPath(root: string): string { return join(root, "dome-keychain-helper"); }
