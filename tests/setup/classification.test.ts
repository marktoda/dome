import { describe, expect, test } from "bun:test";

import {
  classifySetupVault,
  VAULT_KINDS,
  type SetupClassificationEvidence,
} from "../../src/setup/classification";

const base: SetupClassificationEvidence = {
  targetState: "existing",
  gitState: "absent",
  gitDirect: false,
  domeState: "absent",
  blockerCodes: [],
  installedHomeState: "absent",
};

describe("setup vault classification", () => {
  test("maps exact observed evidence onto all seven closed classifications", () => {
    const cases: ReadonlyArray<readonly [SetupClassificationEvidence, typeof VAULT_KINDS[number]]> = [
      [{ ...base, targetState: "missing" }, "new-path"],
      [{ ...base, targetState: "empty-directory" }, "empty-directory"],
      [base, "existing-non-git-vault"],
      [{ ...base, gitState: "clean", gitDirect: true }, "existing-git-vault"],
      [{ ...base, domeState: "configured" }, "existing-dome-vault"],
      [{ ...base, gitState: "operation-active", gitDirect: true, blockerCodes: ["active-git-operation"] },
        "incompatible-active-operation"],
      [{ ...base, blockerCodes: ["unsafe-path"] }, "unsafe-or-ambiguous-state"],
    ];
    expect(cases.map(([evidence]) => classifySetupVault(evidence))).toEqual([...VAULT_KINDS]);
  });

  test("configuration and active-operation evidence outrank lower-level shape", () => {
    expect(classifySetupVault({ ...base, gitState: "clean", gitDirect: true, domeState: "configured" }))
      .toBe("existing-dome-vault");
    expect(classifySetupVault({ ...base, installedHomeState: "upgrade-active", blockerCodes: ["active-home-upgrade"] }))
      .toBe("incompatible-active-operation");
    expect(classifySetupVault({ ...base, blockerCodes: ["active-home-upgrade"] }))
      .toBe("unsafe-or-ambiguous-state");
  });
});
