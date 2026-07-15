import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  decidePwaStaticRequestForTests,
  exerciseHomePwaUpdateRehearsalForTests,
  synthesizePwaPredecessorForTests,
  type UpdateRehearsalOperations,
} from "../../scripts/home-pwa-update-rehearsal";

function candidate(): { index: string; worker: string; revision: string } {
  const index = "<!doctype html><html><head><title>Dome</title></head><body></body></html>";
  const revision = createHash("md5").update(index).digest("hex");
  return {
    index,
    revision,
    worker: `self.__WB_MANIFEST=[{url:"index.html",revision:"${revision}"},{url:"assets/app.js",revision:null}]`,
  };
}

describe("Home PWA synthetic waiting-worker generation", () => {
  test("changes only the marked index generation and its singular MD5 precache revision", () => {
    const input = candidate();
    const generated = synthesizePwaPredecessorForTests(input.index, input.worker);

    expect(generated.candidateIndexMd5).toBe(input.revision);
    expect(generated.indexHtml).toContain(
      '<meta name="dome-rehearsal-generation" content="synthetic-predecessor"></head>',
    );
    expect(generated.predecessorIndexMd5).toBe(
      createHash("md5").update(generated.indexHtml).digest("hex"),
    );
    expect(generated.serviceWorker).toBe(
      input.worker.replace(input.revision, generated.predecessorIndexMd5),
    );
    expect(generated.indexHtml).not.toBe(input.index);
    expect(generated.serviceWorker).not.toBe(input.worker);
    expect(generated.serviceWorker.match(new RegExp(generated.predecessorIndexMd5, "g")))
      .toHaveLength(1);
  });

  test("rejects stale, missing, duplicate, or pre-marked candidate generation data", () => {
    const input = candidate();
    expect(() => synthesizePwaPredecessorForTests(
      input.index,
      input.worker.replace(input.revision, "0".repeat(32)),
    )).toThrow("does not match candidate bytes");
    expect(() => synthesizePwaPredecessorForTests(input.index, "self.__WB_MANIFEST=[]"))
      .toThrow("one index revision");
    expect(() => synthesizePwaPredecessorForTests(input.index, `${input.worker}${input.worker}`))
      .toThrow("one index revision");
    expect(() => synthesizePwaPredecessorForTests(
      input.index.replace("</head>",
        '<meta name="dome-rehearsal-generation" content="synthetic-predecessor"></head>'),
      input.worker,
    )).toThrow("already contains the rehearsal marker");
    expect(() => synthesizePwaPredecessorForTests(input.index.replace("</head>", ""), input.worker))
      .toThrow("one head closure");
  });
});

describe("Home PWA closed static gateway policy", () => {
  const files = ["index.html", "sw.js", "assets/app-123.js", "manifest.webmanifest"];

  test("serves only inventory files with release-safe MIME and cache policy", () => {
    expect(decidePwaStaticRequestForTests("GET", "/", files)).toEqual({
      status: 200,
      file: "index.html",
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-store",
    });
    expect(decidePwaStaticRequestForTests("HEAD", "/sw.js", files)).toEqual({
      status: 200,
      file: "sw.js",
      contentType: "text/javascript; charset=utf-8",
      cacheControl: "no-store",
    });
    expect(decidePwaStaticRequestForTests("GET", "/assets/app-123.js", files).cacheControl)
      .toBe("public, max-age=31536000, immutable");
    expect(decidePwaStaticRequestForTests("GET", "/manifest.webmanifest", files).contentType)
      .toBe("application/manifest+json; charset=utf-8");
  });

  test("does not proxy API, invent a navigation fallback, or admit traversal", () => {
    expect(decidePwaStaticRequestForTests("GET", "/readyz", files).status).toBe(404);
    expect(decidePwaStaticRequestForTests("GET", "/tasks", files).status).toBe(404);
    expect(decidePwaStaticRequestForTests("GET", "/some/app/route", files).status).toBe(404);
    expect(decidePwaStaticRequestForTests("GET", "/%2e%2e/sw.js", files).status).toBe(404);
    expect(decidePwaStaticRequestForTests("GET", "/assets//app-123.js", files).status).toBe(404);
    expect(decidePwaStaticRequestForTests("POST", "/sw.js", files)).toMatchObject({
      status: 405,
      file: null,
    });
  });
});

describe("Home PWA update rehearsal orchestration", () => {
  test("orders every proof before cleanup and returns no evidence document", async () => {
    const seen: string[] = [];
    const result = await exerciseHomePwaUpdateRehearsalForTests(operations(seen));
    expect(result).toBeUndefined();
    expect(seen).toEqual([
      "load", "serve", "launch", "predecessor", "local-capture", "publish",
      "waiting", "activate", "survival", "cleanup",
    ]);
  });

  test("reports phase-only diagnostics and still closes once after a failure", async () => {
    const seen: string[] = [];
    const base = operations(seen);
    await expect(exerciseHomePwaUpdateRehearsalForTests({
      ...base,
      assertWaiting: async () => {
        seen.push("waiting");
        throw new Error("secret browser detail");
      },
    })).rejects.toThrow("Home PWA update rehearsal failed during waiting");
    expect(seen).toEqual([
      "load", "serve", "launch", "predecessor", "local-capture", "publish",
      "waiting", "emergency-close", "cleanup",
    ]);
  });

  test("aborts a bounded phase, settles it, and then cleans up", async () => {
    const seen: string[] = [];
    const base = operations(seen);
    await expect(exerciseHomePwaUpdateRehearsalForTests({
      ...base,
      launch: async (signal) => {
        seen.push("launch");
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            seen.push("launch-aborted");
            resolve();
          }, { once: true });
        });
      },
    }, { phaseMs: 5, cleanupMs: 100 })).rejects.toThrow(
      "Home PWA update rehearsal failed during launch",
    );
    expect(seen).toEqual(["load", "serve", "launch", "launch-aborted", "emergency-close", "cleanup"]);
  });
});

function operations(seen: string[]): UpdateRehearsalOperations {
  const phase = (name: string) => async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    seen.push(name);
  };
  return {
    load: phase("load"),
    serve: phase("serve"),
    launch: phase("launch"),
    assertPredecessor: phase("predecessor"),
    saveLocalCapture: phase("local-capture"),
    publishCandidate: phase("publish"),
    assertWaiting: phase("waiting"),
    activateUpdate: phase("activate"),
    assertSurvival: phase("survival"),
    emergencyClose: async () => { seen.push("emergency-close"); },
    close: phase("cleanup"),
  };
}
