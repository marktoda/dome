// Local-console lifecycle Adapter for durable Product Host device authority.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { type Capability } from "../../capabilities";
import {
  openDeviceAuthority,
  type DeviceAuthority,
  type DeviceRecord,
} from "../../device-authority/device-authority";
import { findGitRoot } from "../../git";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";

const ALL_CAPABILITIES: ReadonlyArray<Capability> = [
  "read", "capture", "resolve", "converse", "author",
];

export type RunDevicesOptions = {
  readonly action: string;
  readonly deviceId?: string | undefined;
  readonly name?: string | undefined;
  readonly grant?: string | undefined;
  readonly vault?: string | undefined;
  readonly json?: boolean | undefined;
};

export async function runDevices(options: RunDevicesOptions): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  if (
    await findGitRoot(vaultPath) === null ||
    !existsSync(join(vaultPath, ".dome", "config.yaml"))
  ) {
    return fail(options, "not an initialized Dome vault; run `dome init` first");
  }
  const opened = await openDeviceAuthority({
    path: join(vaultPath, ".dome", "state", "device-authority.db"),
  });
  if (!opened.ok) return fail(options, `device authority failed to open (${opened.error.kind})`);
  const authority = opened.value.authority;
  try {
    switch (options.action) {
      case "pair":
        return pair(authority, options);
      case "list":
        return list(authority, options);
      case "revoke":
        return revoke(authority, options);
      case "rotate":
        return rotate(authority, options);
      case "invalidate-all":
        return invalidateAll(authority, options);
      default:
        return fail(options, "action must be pair, list, revoke, rotate, or invalidate-all");
    }
  } finally {
    authority.close();
  }
}

function pair(authority: DeviceAuthority, options: RunDevicesOptions): number {
  const name = options.name?.trim() ?? "";
  const capabilities = parseCapabilities(options.grant);
  if (name.length === 0) return fail(options, "devices pair requires --name <device-name>");
  if (capabilities === null) {
    return fail(options, `--grant must be a comma-separated subset of ${ALL_CAPABILITIES.join(",")}`);
  }
  const result = authority.mintPairingGrant({ deviceName: name, capabilities });
  if (result.kind === "invalid") return fail(options, result.message);
  emit(options, {
    schema: "dome.devices.pairing-grant/v1",
    status: "minted",
    deviceName: name,
    capabilities,
    pairingCode: result.pairingCode,
    expiresAt: result.expiresAt,
  }, [
    `Pair ${name} before ${result.expiresAt}`,
    result.pairingCode,
    `grant: ${capabilities.join(",")}`,
  ]);
  return 0;
}

function list(authority: DeviceAuthority, options: RunDevicesOptions): number {
  const devices = authority.listDevices();
  emit(options, {
    schema: "dome.devices/v1",
    authEpoch: authority.authEpoch(),
    devices,
  }, devices.length === 0
    ? ["dome devices: no paired devices."]
    : devices.map(formatDevice));
  return 0;
}

function revoke(authority: DeviceAuthority, options: RunDevicesOptions): number {
  const deviceId = requiredDeviceId(options);
  if (deviceId === null) return EX_USAGE;
  const result = authority.revokeDevice({ deviceId });
  if (result.kind !== "revoked") {
    return fail(options, result.kind === "not-found"
      ? `device '${deviceId}' was not found`
      : `device '${deviceId}' is already revoked`);
  }
  emit(options, {
    schema: "dome.devices.revoke/v1",
    status: "revoked",
    device: result.device,
  }, [`revoked ${result.device.name} (${result.device.id})`]);
  return 0;
}

function rotate(authority: DeviceAuthority, options: RunDevicesOptions): number {
  const deviceId = requiredDeviceId(options);
  if (deviceId === null) return EX_USAGE;
  const result = authority.rotateDeviceCredential({ deviceId });
  if (result.kind !== "rotated") return fail(options, `device credential cannot rotate (${result.kind})`);
  emit(options, {
    schema: "dome.devices.rotate/v1",
    status: "rotated",
    device: result.device,
    credential: result.credential,
    csrfSecret: result.csrfSecret,
    credentialExpiresAt: result.credentialExpiresAt,
  }, [
    `rotated ${result.device.name} (${result.device.id})`,
    `credential: ${result.credential}`,
    `csrf: ${result.csrfSecret}`,
    `expires: ${result.credentialExpiresAt}`,
  ]);
  return 0;
}

function invalidateAll(authority: DeviceAuthority, options: RunDevicesOptions): number {
  const result = authority.invalidateAll();
  emit(options, {
    schema: "dome.devices.invalidate-all/v1",
    status: "invalidated",
    authEpoch: result.authEpoch,
  }, [`invalidated all device credentials; auth epoch is now ${result.authEpoch}`]);
  return 0;
}

function parseCapabilities(raw: string | undefined): Capability[] | null {
  if (raw === undefined) return [...ALL_CAPABILITIES];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    !values.every((value): value is Capability => ALL_CAPABILITIES.includes(value as Capability))
  ) return null;
  return values;
}

function requiredDeviceId(options: RunDevicesOptions): string | null {
  const id = options.deviceId?.trim() ?? "";
  if (id.length > 0) return id;
  fail(options, `devices ${options.action} requires <device-id>`);
  return null;
}

function formatDevice(device: DeviceRecord): string {
  const state = device.revokedAt === null ? "active" : `revoked ${device.revokedAt}`;
  return `${device.id}  ${device.name}  ${state}  ${device.capabilities.join(",")}`;
}

function emit(options: RunDevicesOptions, json: unknown, lines: ReadonlyArray<string>): void {
  console.log(options.json === true ? formatJson(json) : lines.join("\n"));
}

function fail(options: RunDevicesOptions, message: string): number {
  if (options.json === true) {
    console.log(formatJson({ status: "error", error: "devices-usage", message }));
  } else {
    console.error(`dome devices: ${message}`);
  }
  return EX_USAGE;
}
