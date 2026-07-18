import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { type SetupPlan, validateSetupPlan } from "./contracts";

export const SETUP_PLAN_FILE_MAX_BYTES = 2 * 1024 * 1024;

export class SetupPlanFileError extends Error {
  constructor(readonly code: "unavailable" | "unsafe" | "oversized" | "invalid") {
    super(planFileMessage(code));
    this.name = "SetupPlanFileError";
  }
}

/** Read one caller-owned plan without following a symlink or exposing bytes in errors. */
export async function readSetupPlanFile(path: string): Promise<SetupPlan> {
  return createSetupPlanFileReader()(path);
}

type PlanFileReaderDeps = Readonly<{
  /** Test seam at the exact opened-inode proof boundary. */
  afterInitialProof?: (() => Promise<void>) | undefined;
}>;

export function createSetupPlanFileReader(deps: PlanFileReaderDeps = {}) {
  return async (path: string): Promise<SetupPlan> => {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new SetupPlanFileError(hasCode(error, "ENOENT") ? "unavailable" : "unsafe");
    }
    try {
      const initial = await file.stat({ bigint: true });
      if (!initial.isFile() || initial.nlink !== 1n) throw new SetupPlanFileError("unsafe");
      if (initial.size > BigInt(SETUP_PLAN_FILE_MAX_BYTES)) throw new SetupPlanFileError("oversized");
      await deps.afterInitialProof?.();
      const bytes = await readBounded(file);
      const final = await file.stat({ bigint: true });
      let pathFinal;
      try { pathFinal = await lstat(path, { bigint: true }); }
      catch { throw new SetupPlanFileError("unsafe"); }
      if (!sameOpenedProof(initial, final) || !samePathIdentity(final, pathFinal) ||
        final.size !== BigInt(bytes.byteLength)) {
        throw new SetupPlanFileError("unsafe");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        throw new SetupPlanFileError("invalid");
      }
      try {
        return validateSetupPlan(decoded);
      } catch {
        throw new SetupPlanFileError("invalid");
      }
    } finally {
      await file.close();
    }
  };
}

async function readBounded(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remaining = SETUP_PLAN_FILE_MAX_BYTES + 1 - total;
    if (remaining <= 0) throw new SetupPlanFileError("oversized");
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > SETUP_PLAN_FILE_MAX_BYTES) throw new SetupPlanFileError("oversized");
  return Buffer.concat(chunks, total);
}

function sameOpenedProof(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function samePathIdentity(opened: BigIntStats, path: BigIntStats): boolean {
  return path.isFile() && path.nlink === 1n && sameOpenedProof(opened, path);
}

function planFileMessage(code: SetupPlanFileError["code"]): string {
  if (code === "unavailable") return "the setup plan file is unavailable";
  if (code === "oversized") return `the setup plan file exceeds ${SETUP_PLAN_FILE_MAX_BYTES} bytes`;
  if (code === "invalid") return "the setup plan file is not a valid Dome setup plan";
  return "the setup plan file is not a safe direct regular file";
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}
