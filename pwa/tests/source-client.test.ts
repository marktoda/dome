import { afterEach, describe, expect, test } from "bun:test";

import { fetchSourceDocument } from "../src/source/source-client";

const COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function reply(overrides: Record<string, unknown> = {}): void {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    schema: "dome.source-document/v1",
    status: "ok",
    path: "wiki/source.md",
    commit: COMMIT,
    content: "evidence",
    ...overrides,
  }))) as unknown as typeof fetch;
}

const execute = (request: Request): Promise<Response> => fetch(request);

describe("exact source client", () => {
  test("accepts only a response for the requested path and lowercase commit", async () => {
    reply();
    expect(await fetchSourceDocument({ path: "wiki/source.md", commit: COMMIT }, execute)).toMatchObject({ status: "ok" });
  });

  test("rejects a valid document carrying a substituted path", async () => {
    reply({ path: "wiki/other.md" });
    await expect(fetchSourceDocument({ path: "wiki/source.md", commit: COMMIT }, execute))
      .rejects.toThrow("did not match");
  });

  test("rejects a valid document carrying a substituted commit", async () => {
    reply({ commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    await expect(fetchSourceDocument({ path: "wiki/source.md", commit: COMMIT }, execute))
      .rejects.toThrow("did not match");
  });
});
