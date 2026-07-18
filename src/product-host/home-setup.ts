// product-host/home-setup: derived, persistence-free setup for Home's one
// shipped model-provider integration. Vault config remains source of truth.

import { HomeCredentialError, openHomeCredentials, type HomeCredentials } from "./home-credentials";
import {
  inspectHomeCredentialResidue,
  type HomeCredentialResidueInspection,
} from "./home-credential-residue";
import {
  resolveHomeModelRuntime,
  type HomeModelRuntime,
} from "./home-model-provider";

export const HOME_SETUP_SCHEMA = "dome.home.setup/v1" as const;
export type HomeSetupAction = "status" | "configure" | "remove" | "check";

export type HomeSetupResult = Readonly<{
  schema: typeof HOME_SETUP_SCHEMA;
  action: HomeSetupAction;
  status: "ready" | "incomplete" | "configured" | "removed" | "present" | "missing" | "locked" | "denied" | "error";
  exitCode: 0 | 1 | 64;
  model: Readonly<{
    configuration: HomeModelRuntime["configuration"];
    credential: HomeModelRuntime["credential"];
    runtime: HomeModelRuntime["modelState"];
  }>;
  residue: HomeCredentialResidueInspection;
  nextAction: "none" | "configure-model" | "initialize-model-provider" | "configure-model-provider" | "inspect-credential-residue" | "unlock-keychain";
  message: string;
}>;

export type HomeSetupDeps = Readonly<{
  credentials?: HomeCredentials;
  inspectResidue?: typeof inspectHomeCredentialResidue;
  resolveModel?: typeof resolveHomeModelRuntime;
  helperPath?: string;
}>;

export async function manageHomeSetup(input: Readonly<{
  action: HomeSetupAction;
  vaultPath: string;
}>, deps: HomeSetupDeps = {}): Promise<HomeSetupResult> {
  const credentials = deps.credentials ?? openHomeCredentials(
    deps.helperPath === undefined ? {} : { helperPath: deps.helperPath },
  );
  const inspectResidue = deps.inspectResidue ?? inspectHomeCredentialResidue;
  const resolveModel = deps.resolveModel ?? ((vault: string) =>
    resolveHomeModelRuntime(vault, { credentials }));

  if (input.action === "configure") {
    const before = await resolveModel(input.vaultPath);
    if (before.configuration !== "shipped-anthropic") {
      return await output(input, before, inspectResidue,
        "error", 64, configurationMessage(before.configuration), configurationNext(before.configuration));
    }
    try {
      await credentials.configure(input.vaultPath);
      const after = await resolveModel(input.vaultPath);
      if (after.modelState !== "ready") {
        return await output(input, after, inspectResidue, "error", 1,
          "model credential was stored but the shipped provider probe did not succeed", "configure-model");
      }
      const residue = await inspectResidue(input.vaultPath);
      return result(input.action, after, residue, "configured", 0,
        "model credential configured and provider probe succeeded", deriveNext(after, residue));
    } catch (error) { return await credentialFailure(input, resolveModel, inspectResidue, error); }
  }

  if (input.action === "remove") {
    const before = await resolveModel(input.vaultPath);
    if (before.configuration !== "shipped-anthropic") {
      return await output(input, before, inspectResidue,
        "error", 64, configurationMessage(before.configuration), configurationNext(before.configuration));
    }
    try {
      await credentials.remove(input.vaultPath);
      const after = await resolveModel(input.vaultPath);
      return await output(input, after, inspectResidue, "removed", 0,
        "model credential removed or already absent; subsequent provider launches see it missing", "configure-model");
    } catch (error) { return await credentialFailure(input, resolveModel, inspectResidue, error); }
  }

  const model = await resolveModel(input.vaultPath);
  if (input.action === "check") {
    if (model.configuration !== "shipped-anthropic") {
      return await output(input, model, inspectResidue,
        "error", 64, configurationMessage(model.configuration), configurationNext(model.configuration));
    }
    const ready = model.credential === "present" && model.modelState === "ready";
    const status = model.credential === "locked" ? "locked" : model.credential === "denied" ? "denied" : ready ? "present" : "missing";
    return await output(input, model, inspectResidue, status, ready ? 0 : 1,
      ready ? "model credential is readable and provider probe succeeded" : "model provider setup is not ready",
      ready ? "none" : status === "locked" || status === "denied" ? "unlock-keychain" : "configure-model");
  }

  const residue = await inspectResidue(input.vaultPath);
  const nextAction = deriveNext(model, residue);
  const ready = nextAction === "none";
  return result(input.action, model, residue, ready ? "ready" : "incomplete", ready ? 0 : 1,
    ready ? "Dome Home model setup is ready" : "Dome Home model setup is incomplete", nextAction);
}

async function output(
  input: Readonly<{ action: HomeSetupAction; vaultPath: string }>,
  model: HomeModelRuntime,
  inspectResidue: typeof inspectHomeCredentialResidue,
  status: HomeSetupResult["status"],
  exitCode: HomeSetupResult["exitCode"],
  message: string,
  nextAction: HomeSetupResult["nextAction"],
): Promise<HomeSetupResult> {
  return result(input.action, model, await inspectResidue(input.vaultPath), status, exitCode, message, nextAction);
}

function result(
  action: HomeSetupAction,
  model: HomeModelRuntime,
  residue: HomeCredentialResidueInspection,
  status: HomeSetupResult["status"],
  exitCode: HomeSetupResult["exitCode"],
  message: string,
  nextAction: HomeSetupResult["nextAction"],
): HomeSetupResult {
  return Object.freeze({ schema: HOME_SETUP_SCHEMA, action, status, exitCode,
    model: Object.freeze({ configuration: model.configuration, credential: model.credential, runtime: model.modelState }),
    residue, nextAction, message });
}

async function credentialFailure(
  input: Readonly<{ action: HomeSetupAction; vaultPath: string }>,
  resolveModel: typeof resolveHomeModelRuntime,
  inspectResidue: typeof inspectHomeCredentialResidue,
  error: unknown,
): Promise<HomeSetupResult> {
  const model = await resolveModel(input.vaultPath);
  const code = error instanceof HomeCredentialError ? error.code : "failed";
  const status = code === "missing" ? "missing" : code === "locked" ? "locked" : code === "denied" ? "denied" : "error";
  return await output(input, model, inspectResidue, status, status === "missing" ? 64 : 1,
    status === "locked" ? "Dome Home Keychain is locked or unavailable"
      : status === "denied" ? "Dome Home Keychain access was denied"
        : status === "missing" ? "Dome Home model credential is not configured"
          : "Dome Home model credential operation failed",
    status === "locked" || status === "denied" ? "unlock-keychain" : "configure-model");
}

function deriveNext(
  model: HomeModelRuntime,
  residue: HomeCredentialResidueInspection,
): HomeSetupResult["nextAction"] {
  if (model.configuration === "missing") return "initialize-model-provider";
  if (model.configuration !== "shipped-anthropic") return "configure-model-provider";
  if (model.credential === "locked" || model.credential === "denied") return "unlock-keychain";
  if (model.credential !== "present" || model.modelState !== "ready") return "configure-model";
  if (residue.state !== "clean") return "inspect-credential-residue";
  return "none";
}

function configurationMessage(configuration: HomeModelRuntime["configuration"]): string {
  if (configuration === "custom") return "custom model_provider configuration is preserved and not managed by Home setup";
  if (configuration === "missing") return "initialize the managed model-provider configuration before storing a Home credential";
  return "vault model_provider configuration is invalid";
}

function configurationNext(configuration: HomeModelRuntime["configuration"]): HomeSetupResult["nextAction"] {
  return configuration === "missing" ? "initialize-model-provider" : "configure-model-provider";
}
