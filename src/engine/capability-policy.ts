// capability-policy: vault config → effective bundle grants.
//
// Processors declare their requested capabilities in manifest.yaml. The
// vault grants capabilities in .dome/config.yaml under
// `extensions.<bundle>.grant` (or the documented plural `grants`). The
// broker receives the intersection: declaration from the processor, grant
// from this policy resolver.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { Capability } from "../core/processor";
import { err, ok, type Result } from "../types";

export type CapabilityPolicy = {
  readonly foundConfig: boolean;
  readonly grantsForExtension: (
    extensionId: string,
  ) => ReadonlyArray<Capability>;
};

export async function loadCapabilityPolicy(
  vaultPath: string,
): Promise<Result<CapabilityPolicy, string>> {
  const path = join(vaultPath, ".dome", "config.yaml");
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (e) {
    if (isMissingFile(e)) {
      return ok(emptyPolicy(false));
    }
    return err(`failed to read ${path}: ${messageFor(e)}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(body);
  } catch (e) {
    return err(`failed to parse ${path}: ${messageFor(e)}`);
  }

  const root = asRecord(parsed);
  if (root === null) {
    return err(`${path} must be a YAML mapping`);
  }

  const grants = new Map<string, ReadonlyArray<Capability>>();
  const extensions = asRecord(root.extensions);
  if (extensions !== null) {
    for (const [extensionId, rawExtension] of Object.entries(extensions)) {
      const extension = asRecord(rawExtension);
      if (extension === null) continue;
      if (extension.enabled === false) {
        grants.set(extensionId, Object.freeze([]));
        continue;
      }
      const rawGrant = extension.grant ?? extension.grants;
      grants.set(extensionId, parseGrantBlock(rawGrant));
    }
  }

  return ok(
    Object.freeze({
      foundConfig: true,
      grantsForExtension: (extensionId: string) =>
        grants.get(extensionId) ?? Object.freeze([]),
    }),
  );
}

function emptyPolicy(foundConfig: boolean): CapabilityPolicy {
  return Object.freeze({
    foundConfig,
    grantsForExtension: () => Object.freeze([]),
  });
}

function parseGrantBlock(raw: unknown): ReadonlyArray<Capability> {
  const grant = asRecord(raw);
  if (grant === null) return Object.freeze([]);

  const capabilities: Capability[] = [];
  pushPathCapability(capabilities, "read", grant.read);
  pushPathCapability(capabilities, "patch.propose", grant["patch.propose"]);
  pushPathCapability(capabilities, "patch.auto", grant["patch.auto"]);
  pushPathCapability(capabilities, "owns.path", grant["owns.path"]);
  pushPathCapability(capabilities, "search.write", grant["search.write"]);
  pushRegionCapability(capabilities, grant["owns.region"]);
  pushGraphWriteCapability(capabilities, grant["graph.write"]);
  pushQuestionAskCapability(capabilities, grant["question.ask"]);
  pushJobEnqueueCapability(capabilities, grant["job.enqueue"]);
  pushModelInvokeCapability(capabilities, grant["model.invoke"]);
  pushExternalCapability(capabilities, grant.external);
  pushOutboxReadCapability(capabilities, grant["outbox.read"]);
  pushOutboxRecoverCapability(capabilities, grant["outbox.recover"]);
  return Object.freeze(capabilities);
}

function pushPathCapability(
  out: Capability[],
  kind: "read" | "patch.propose" | "patch.auto" | "owns.path" | "search.write",
  raw: unknown,
): void {
  const paths = stringArray(raw);
  if (paths === null) return;
  out.push({ kind, paths });
}

function pushRegionCapability(out: Capability[], raw: unknown): void {
  const regionIds = stringArray(raw);
  if (regionIds === null) return;
  out.push({ kind: "owns.region", regionIds });
}

function pushGraphWriteCapability(out: Capability[], raw: unknown): void {
  const namespaces = stringArray(raw);
  if (namespaces === null) return;
  out.push({ kind: "graph.write", namespaces });
}

function pushQuestionAskCapability(out: Capability[], raw: unknown): void {
  if (raw === true) {
    out.push({ kind: "question.ask" });
    return;
  }
  const namespaces = stringArray(raw);
  if (namespaces === null) return;
  out.push({ kind: "question.ask", namespaces });
}

function pushJobEnqueueCapability(out: Capability[], raw: unknown): void {
  const processors = stringArray(raw);
  if (processors === null) return;
  out.push({ kind: "job.enqueue", processors });
}

function pushModelInvokeCapability(out: Capability[], raw: unknown): void {
  if (raw === true) {
    out.push({ kind: "model.invoke" });
    return;
  }
  const grant = asRecord(raw);
  if (grant === null) return;
  const built: {
    kind: "model.invoke";
    maxDailyCostUsd?: number;
    modelAllowlist?: ReadonlyArray<string>;
  } = { kind: "model.invoke" };
  if (typeof grant.maxDailyCostUsd === "number") {
    built.maxDailyCostUsd = grant.maxDailyCostUsd;
  }
  const modelAllowlist = stringArray(grant.modelAllowlist);
  if (modelAllowlist !== null) {
    built.modelAllowlist = modelAllowlist;
  }
  out.push(built);
}

function pushExternalCapability(out: Capability[], raw: unknown): void {
  const capabilities = stringArray(raw);
  if (capabilities === null) return;
  for (const capability of capabilities) {
    out.push({ kind: "external", capability });
  }
}

function pushOutboxReadCapability(out: Capability[], raw: unknown): void {
  if (raw === true) {
    out.push({ kind: "outbox.read" });
    return;
  }
  const statuses = stringArray(raw)?.filter(
    (status): status is "pending" | "sent" | "failed" | "abandoned" =>
      status === "pending" ||
      status === "sent" ||
      status === "failed" ||
      status === "abandoned",
  );
  if (statuses === undefined || statuses.length === 0) return;
  out.push({ kind: "outbox.read", statuses });
}

function pushOutboxRecoverCapability(out: Capability[], raw: unknown): void {
  if (raw === true) {
    out.push({ kind: "outbox.recover", actions: ["retry", "abandon"] });
    return;
  }
  const actions = stringArray(raw)?.filter(
    (action): action is "retry" | "abandon" =>
      action === "retry" || action === "abandon",
  );
  if (actions === undefined || actions.length === 0) return;
  out.push({ kind: "outbox.recover", actions });
}

function stringArray(raw: unknown): ReadonlyArray<string> | null {
  if (typeof raw === "string") return Object.freeze([raw]);
  if (!Array.isArray(raw)) return null;
  const values = raw.filter((value): value is string => typeof value === "string");
  if (values.length === 0) return null;
  return Object.freeze(values);
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function isMissingFile(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { readonly code?: unknown }).code === "ENOENT"
  );
}

function messageFor(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
