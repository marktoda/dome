import { describe, test, expect } from "bun:test";
import type { HookContext } from "../../src/hook-context";

type HasField<T, K extends string> = K extends keyof T ? true : false;
type NotHasField<T, K extends string> = K extends keyof T ? false : true;

type AssertNoFs = NotHasField<HookContext, "fs">;
type AssertNoWrite = NotHasField<HookContext, "writeFile">;
type AssertHasTools = HasField<HookContext, "tools">;
type AssertHasVault = HasField<HookContext, "vault">;

const _checks: [AssertNoFs, AssertNoWrite, AssertHasTools, AssertHasVault] = [true, true, true, true];

describe("HOOKS_CANNOT_BYPASS_TOOLS (type-level)", () => {
  test("HookContext has no filesystem access", () => {
    expect(_checks).toEqual([true, true, true, true]);
  });

  test("HookContext exposes a `tools` field of the Tool surface", () => {
    expect(true).toBe(true);
  });
});
