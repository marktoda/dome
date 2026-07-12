import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "../../src/assistant/runtime";
import type { Capability } from "../../src/capabilities";
import { openDeviceAuthority, type DeviceAuthority } from "../../src/device-authority/device-authority";
import { createDomeHttpServer } from "../../src/http/server";

const ORIGIN = "https://dome.example";

async function authority(): Promise<DeviceAuthority> {
  const dir = mkdtempSync(join(tmpdir(), "dome-device-server-"));
  const opened = await openDeviceAuthority({ path: join(dir, "authority.db") });
  if (!opened.ok) throw new Error(`device authority open failed: ${opened.error.kind}`);
  return opened.value.authority;
}

async function pair(
  store: DeviceAuthority,
  server: ReturnType<typeof createDomeHttpServer>,
  name: string,
  capabilities: ReadonlyArray<Capability> = ["read", "converse"],
): Promise<{ deviceId: string; cookie: string; csrf: string }> {
  const grant = store.mintPairingGrant({
    deviceName: name,
    capabilities,
  });
  if (grant.kind !== "minted") throw new Error("grant failed");
  const response = await server.fetch(new Request(`${ORIGIN}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ code: grant.pairingCode }),
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as {
    device: { id: string };
    csrfToken: string;
  };
  const cookies = response.headers.getSetCookie()
    .map((value) => value.split(";", 1)[0]!)
    .join("; ");
  return { deviceId: body.device.id, cookie: cookies, csrf: body.csrfToken };
}

describe("durable device HTTP mode", () => {
  test("cannot be combined with compatibility authority", async () => {
    const store = await authority();
    expect(() => createDomeHttpServer({
      vaultPath: "/tmp/unused",
      deviceAuth: { authority: store, allowedOrigins: () => [ORIGIN] },
      token: "legacy-root-token",
    })).toThrow("cannot use a compatibility token");
    store.close();
  });

  test("isolates devices and sessions, revokes immediately, and reuses CSRF after reload", async () => {
    const store = await authority();
    let runtimeNow = 0;
    const turnContexts: Array<{ deviceId: string; capabilities: string[] }> = [];
    const runtime = createAgentRuntime({
      createId: (() => { let n = 0; return () => `session-${++n}`; })(),
      runTurn: ({ question, sessionContext }) => {
        if (sessionContext !== undefined) turnContexts.push({
          deviceId: sessionContext.deviceId,
          capabilities: [...sessionContext.capabilities].sort(),
        });
        if (question === "explode") throw new Error("provider secret sk-do-not-leak");
        return ({
        text: (async function* () { yield "ok"; })(),
        finished: Promise.resolve({ citations: [], changes: [], stopReason: "final" }),
        });
      },
      now: () => runtimeNow,
      limits: { idleTtlMs: 10 },
    });
    const server = createDomeHttpServer({
      vaultPath: "/tmp/unused",
      deviceAuth: { authority: store, allowedOrigins: () => [ORIGIN] },
      agentRuntime: runtime,
      readiness: async (client) => ({ deviceId: client?.deviceId }),
      transcribeApiKey: "provider-key",
    });
    const first = await pair(store, server, "phone");
    const second = await pair(store, server, "laptop", ["read", "converse", "capture"]);
    expect((await server.fetch(new Request(`${ORIGIN}/?token=legacy-root-token`))).status).toBe(401);

    const status = await server.fetch(new Request(`${ORIGIN}/pair/status`, {
      headers: { cookie: first.cookie },
    }));
    expect(await status.json()).toMatchObject({ paired: true, device: { id: first.deviceId, name: "phone" } });
    const ready = await server.fetch(new Request(`${ORIGIN}/readyz`, {
      headers: { cookie: second.cookie },
    }));
    expect(await ready.json()).toEqual({ deviceId: second.deviceId });
    const identity = await server.fetch(new Request(`${ORIGIN}/`, { headers: { cookie: second.cookie } }));
    expect(await identity.json()).toMatchObject({ capabilities: ["capture", "converse", "read"] });

    const wrongOrigin = await server.fetch(new Request(`${ORIGIN}/sessions`, {
      method: "POST",
      headers: { cookie: first.cookie, origin: "https://attacker.example", "x-dome-csrf": first.csrf },
    }));
    expect(wrongOrigin.status).toBe(403);

    const created = await server.fetch(new Request(`${ORIGIN}/sessions`, {
      method: "POST",
      headers: { cookie: first.cookie, origin: ORIGIN, "x-dome-csrf": first.csrf },
    }));
    expect(created.status).toBe(201);
    const crossDevice = await server.fetch(new Request(`${ORIGIN}/sessions/session-1/messages`, {
      method: "POST",
      headers: {
        cookie: second.cookie,
        origin: ORIGIN,
        "x-dome-csrf": second.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "not yours" }),
    }));
    expect(crossDevice.status).toBe(404);
    const ownTurn = await server.fetch(new Request(`${ORIGIN}/sessions/session-1/messages`, {
      method: "POST",
      headers: {
        cookie: first.cookie,
        origin: ORIGIN,
        "x-dome-csrf": first.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "mine" }),
    }));
    expect(ownTurn.status).toBe(200);
    await ownTurn.text();
    expect(turnContexts).toEqual([{
      deviceId: first.deviceId,
      capabilities: ["converse", "read"],
    }]);

    const reloadedMutation = await server.fetch(new Request(`${ORIGIN}/sessions`, {
      method: "POST",
      headers: { cookie: first.cookie, origin: ORIGIN, "x-dome-csrf": first.csrf },
    }));
    expect(reloadedMutation.status).toBe(201);
    const redacted = await server.fetch(new Request(`${ORIGIN}/sessions/session-2/messages`, {
      method: "POST",
      headers: {
        cookie: first.cookie,
        origin: ORIGIN,
        "x-dome-csrf": first.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "explode" }),
    }));
    const redactedBody = await redacted.text();
    expect(redactedBody).toContain("The assistant turn failed. Reference request");
    expect(redactedBody).not.toContain("sk-do-not-leak");

    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(
      "provider response contains sk-provider-secret",
      { status: 401 },
    )) as unknown as typeof fetch;
    try {
      const transcription = await server.fetch(new Request(`${ORIGIN}/transcribe`, {
        method: "POST",
        headers: {
          cookie: second.cookie,
          origin: ORIGIN,
          "x-dome-csrf": second.csrf,
          "content-type": "audio/webm",
        },
        body: new Uint8Array([1, 2, 3]),
      }));
      const transcriptionBody = await transcription.text();
      expect(transcription.status).toBe(502);
      expect(transcriptionBody).toContain("Transcription could not be completed.");
      expect(transcriptionBody).not.toContain("sk-provider-secret");
    } finally {
      globalThis.fetch = realFetch;
    }

    runtimeNow = 10;
    const hiddenExpiry = await server.fetch(new Request(`${ORIGIN}/sessions/session-1/cancel`, {
      method: "POST",
      headers: { cookie: second.cookie, origin: ORIGIN, "x-dome-csrf": second.csrf },
    }));
    expect(hiddenExpiry.status).toBe(404);
    const ownedExpiry = await server.fetch(new Request(`${ORIGIN}/sessions/session-1/cancel`, {
      method: "POST",
      headers: { cookie: first.cookie, origin: ORIGIN, "x-dome-csrf": first.csrf },
    }));
    expect(ownedExpiry.status).toBe(410);

    expect(store.revokeDevice({ deviceId: first.deviceId }).kind).toBe("revoked");
    const revoked = await server.fetch(new Request(`${ORIGIN}/`, { headers: { cookie: first.cookie } }));
    const unaffected = await server.fetch(new Request(`${ORIGIN}/`, { headers: { cookie: second.cookie } }));
    expect(revoked.status).toBe(401);
    expect(unaffected.status).toBe(200);
    await server.close();
    store.close();
  });
});
