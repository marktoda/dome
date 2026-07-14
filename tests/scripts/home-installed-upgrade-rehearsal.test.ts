import { describe, expect, test } from "bun:test";

import {
  exerciseInstalledUpgradeOrchestrationForTests,
  type InstalledHomeUpgradeRehearsalInput,
  type InstalledHomeUpgradeScenario,
} from "../../scripts/home-installed-upgrade-rehearsal";

const INPUT: InstalledHomeUpgradeRehearsalInput = Object.freeze({
  predecessorArchive: "/synthetic/predecessor.tar.gz",
  candidateArchive: "/synthetic/candidate.tar.gz",
  frozenFixtureRoot: "/synthetic/fixture",
});

describe("installed Home upgrade portable orchestration (explicitly non-evidence)", () => {
  test("runs the three scenarios sequentially and cleans each boundary", async () => {
    const events: string[] = [];
    let active = false;
    const result = await exerciseInstalledUpgradeOrchestrationForTests(INPUT, {
      prepare: async (input) => {
        events.push(`prepare:${input.candidateArchive}`);
        return Object.freeze({ token: "synthetic" });
      },
      runScenario: async (name, prepared) => {
        expect(prepared.token).toBe("synthetic");
        expect(active).toBeFalse();
        active = true;
        events.push(`run:${name}`);
      },
      cleanupScenario: async (name) => {
        expect(active).toBeTrue();
        active = false;
        events.push(`scenario-clean:${name}`);
      },
      cleanup: async (prepared) => { events.push(`clean:${prepared?.token ?? "null"}`); },
    });

    expect(result).toEqual({
      evidence: false,
      scenarios: ["ready-success", "stopped-precommit-crash", "committed-exact-repair"],
    });
    expect("schema" in result).toBeFalse();
    expect(events).toEqual([
      "prepare:/synthetic/candidate.tar.gz",
      "run:ready-success",
      "scenario-clean:ready-success",
      "run:stopped-precommit-crash",
      "scenario-clean:stopped-precommit-crash",
      "run:committed-exact-repair",
      "scenario-clean:committed-exact-repair",
      "clean:synthetic",
    ]);
  });

  test("cleans the failing scenario and global preparation without emitting evidence", async () => {
    const events: string[] = [];
    const failure: InstalledHomeUpgradeScenario = "stopped-precommit-crash";
    await expect(exerciseInstalledUpgradeOrchestrationForTests(INPUT, {
      prepare: async () => ({ token: "synthetic" }),
      runScenario: async (name) => {
        events.push(`run:${name}`);
        if (name === failure) throw new Error("synthetic failure");
      },
      cleanupScenario: async (name) => { events.push(`scenario-clean:${name}`); },
      cleanup: async (prepared) => { events.push(`clean:${prepared?.token ?? "null"}`); },
    })).rejects.toThrow("synthetic failure");
    expect(events).toEqual([
      "run:ready-success",
      "scenario-clean:ready-success",
      "run:stopped-precommit-crash",
      "scenario-clean:stopped-precommit-crash",
      "clean:synthetic",
    ]);
  });

  test("runs global cleanup with null when preparation itself fails", async () => {
    const events: string[] = [];
    await expect(exerciseInstalledUpgradeOrchestrationForTests(INPUT, {
      prepare: async () => { throw new Error("synthetic prepare failure"); },
      runScenario: async () => { throw new Error("unreachable"); },
      cleanupScenario: async () => { throw new Error("unreachable"); },
      cleanup: async (prepared) => { events.push(prepared === null ? "clean:null" : "bad"); },
    })).rejects.toThrow("synthetic prepare failure");
    expect(events).toEqual(["clean:null"]);
  });
});
