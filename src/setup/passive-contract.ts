import { types as utilTypes } from "node:util";

import { CONTENT_SCOPE_MAX_GLOBS } from "../core/content-scope";

export const SETUP_CONTRACT_LIMITS = Object.freeze({
  markdownPaths: 100_000,
  repositoryCandidates: 100_000,
  scopeGlobs: CONTENT_SCOPE_MAX_GLOBS,
  actions: 8,
  blockers: 12,
  optionalSteps: 2,
  writeBytes: 1024 * 1024,
  warnings: 64,
  recoveryCommands: 32,
});

const MAX_OBJECT_KEYS = 64;
const MAX_DEPTH = 12;
// A maximum candidate contributes one object plus its six primitive fields;
// the two Markdown inventories and baseline path inventory contribute three
// more primitive rows. Keep one aggregate budget rather than per-field walks.
const MAX_NODES = SETUP_CONTRACT_LIMITS.repositoryCandidates * 7 +
  SETUP_CONTRACT_LIMITS.markdownPaths * 3 + 4_096;

/**
 * Compile untrusted contract input into inert data before Zod can traverse it.
 * Arrays are rejected from their length descriptor before any element walk.
 */
export function passiveSetupContractSnapshot(input: unknown, label: string): unknown {
  const budget = { nodes: MAX_NODES };
  try {
    return snapshotValue(input, [], 0, budget);
  } catch (error) {
    const message = error instanceof Error ? error.message : "cannot be inspected safely";
    throw new Error(`${label} ${message}`);
  }
}

export function deepFreezeSetupContract<T>(input: T): T {
  if (typeof input !== "object" || input === null) return input;
  for (const value of Object.values(input)) deepFreezeSetupContract(value);
  return Object.isFrozen(input) ? input : Object.freeze(input);
}

function snapshotValue(
  input: unknown,
  path: ReadonlyArray<string | number>,
  depth: number,
  budget: { nodes: number },
): unknown {
  if (budget.nodes-- <= 0) throw new Error("exceeds the passive data budget");
  if (typeof input !== "object" || input === null) return input;
  if (utilTypes.isProxy(input)) throw new Error(`${formatPath(path)} must not be a Proxy`);
  if (depth > MAX_DEPTH) throw new Error(`${formatPath(path)} exceeds the nesting budget`);
  return Array.isArray(input)
    ? snapshotArray(input, path, depth, budget)
    : snapshotObject(input, path, depth, budget);
}

function snapshotArray(
  input: unknown[],
  path: ReadonlyArray<string | number>,
  depth: number,
  budget: { nodes: number },
): ReadonlyArray<unknown> {
  if (Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${formatPath(path)} must be a plain data array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0) throw new Error(`${formatPath(path)} has an invalid length`);
  const cap = arrayCap(path);
  if (length > cap) throw new Error(`${formatPath(path)} must contain at most ${cap} entries`);
  if (length > budget.nodes) throw new Error("exceeds the passive data budget");

  const keys = Object.keys(input);
  if (keys.some((key) => !isArrayIndex(key, length))) {
    throw new Error(`${formatPath(path)} must contain indexed data only`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined) {
      output.push(snapshotValue(undefined, [...path, index], depth + 1, budget));
      continue;
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(`${formatPath([...path, index])} must be a data property`);
    }
    output.push(snapshotValue(descriptor.value, [...path, index], depth + 1, budget));
  }
  return Object.freeze(output);
}

function snapshotObject(
  input: object,
  path: ReadonlyArray<string | number>,
  depth: number,
  budget: { nodes: number },
): Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${formatPath(path)} must be a plain data object`);
  }
  const keys = Object.keys(input);
  if (keys.length > MAX_OBJECT_KEYS) throw new Error(`${formatPath(path)} has too many fields`);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(`${formatPath([...path, key])} must be an enumerable data property`);
    }
    output[key] = snapshotValue(descriptor.value, [...path, key], depth + 1, budget);
  }
  return Object.freeze(output);
}

function arrayCap(path: ReadonlyArray<string | number>): number {
  const key = path.at(-1);
  if (key === "tracked" || key === "untracked" || key === "baselineTracked") {
    return SETUP_CONTRACT_LIMITS.markdownPaths;
  }
  if (key === "candidates") return SETUP_CONTRACT_LIMITS.repositoryCandidates;
  if (key === "include" || key === "exclude") return SETUP_CONTRACT_LIMITS.scopeGlobs;
  if (key === "actions") return SETUP_CONTRACT_LIMITS.actions;
  if (key === "blockers") return SETUP_CONTRACT_LIMITS.blockers;
  if (key === "optionalSteps") return SETUP_CONTRACT_LIMITS.optionalSteps;
  if (key === "recoveryCommands") return SETUP_CONTRACT_LIMITS.recoveryCommands;
  if (key === "warnings") return SETUP_CONTRACT_LIMITS.warnings;
  if (key === "prerequisites") return 2;
  return MAX_OBJECT_KEYS;
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function formatPath(path: ReadonlyArray<string | number>): string {
  return path.length === 0 ? "$" : `$.${path.join(".")}`;
}
