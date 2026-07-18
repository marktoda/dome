import { describe, expect, test } from "bun:test";

import {
  cleanupOwnedProductFixtures,
  closeTrackedProductFixture,
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
});
