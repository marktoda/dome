import { describe, expect, test } from "bun:test";

import {
  cleanupOwnedProductFixtures,
  closeTrackedProductFixture,
  startOwnedProductFixture,
} from "./support/owned-fixture-cleanup";

describe("Product Host fixture ownership", () => {
  test("closes every owner before removing its roots", async () => {
    const events: string[] = [];
    const hosts = [{ close: async () => { events.push("close"); } }];
    const roots = ["vault", "support"];

    await cleanupOwnedProductFixtures(hosts, roots, {
      removeRoot: async (root) => { events.push(`remove:${root}`); },
      timeoutMs: 10,
    });

    expect(events).toEqual(["close", "remove:vault", "remove:support"]);
    expect(hosts).toEqual([]);
    expect(roots).toEqual([]);
  });

  test("a stalled close retains every root with an exact bounded diagnostic", async () => {
    const removed: string[] = [];
    const hosts = [{ close: () => new Promise<void>(() => {}) }];
    const roots = ["vault", "support"];

    await expect(cleanupOwnedProductFixtures(hosts, roots, {
      removeRoot: async (root) => { removed.push(root); },
      timeoutMs: 5,
    })).rejects.toThrow(
      "product fixture cleanup retained 2 root(s) after 1 host close failure(s): "
        + "host 1 close exceeded 5ms",
    );
    expect(removed).toEqual([]);
    expect(hosts).toEqual([]);
    expect(roots).toEqual([]);
  });

  test("a tracked host remains owned when its early close stalls", async () => {
    const host = { close: () => new Promise<void>(() => {}) };
    const hosts = [host];

    await expect(closeTrackedProductFixture(host, hosts, 5))
      .rejects.toThrow("tracked host close exceeded 5ms");
    expect(hosts).toEqual([host]);
  });

  test("a stalled start owns cleanup before awaiting and retains every root", async () => {
    let settleStart!: (result: { ok: false }) => void;
    const stalled = new Promise<{ ok: false }>((resolve) => { settleStart = resolve; });
    const hosts: Array<{ close: () => Promise<void> }> = [];
    const roots = ["vault"];
    const removed: string[] = [];
    const starting = startOwnedProductFixture(
      hosts,
      () => stalled,
      () => null,
    );
    await Promise.resolve();
    expect(hosts).toHaveLength(1);

    await expect(cleanupOwnedProductFixtures(hosts, roots, {
      removeRoot: async (root) => { removed.push(root); },
      timeoutMs: 5,
    })).rejects.toThrow(
      "product fixture cleanup retained 1 root(s) after 1 host close failure(s): "
        + "host 1 close exceeded 5ms",
    );
    expect(removed).toEqual([]);
    expect(hosts).toEqual([]);
    expect(roots).toEqual([]);

    settleStart({ ok: false });
    await expect(starting).resolves.toEqual({ ok: false });
  });

  test("a successful start atomically replaces its pending owner", async () => {
    let closes = 0;
    const owner = { close: async () => { closes += 1; } };
    const hosts: Array<{ close: () => Promise<void> }> = [];

    await expect(startOwnedProductFixture(
      hosts,
      async () => ({ ok: true as const, owner }),
      (result) => result.owner,
    )).resolves.toEqual({ ok: true, owner });
    expect(hosts).toEqual([owner]);
    await hosts[0]!.close();
    expect(closes).toBe(1);
  });
});
