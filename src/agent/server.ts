// src/agent/server.ts
//
// The "ask my brain" HTTP surface: a single POST /ask route that authenticates
// a bearer token, validates the question body, runs the ask agent, and returns
// the answer + citations.  Mirrors src/http/server.ts auth + mutex idioms
// exactly; the vault/provider plumbing is identical — just a narrower route
// table.

import { createHash, timingSafeEqual } from "node:crypto";
import {
  makeVaultMutex,
  openVaultErrorKind,
  withVault as withVaultShared,
} from "../surface/adapter";
import { runAsk } from "./ask";
import { askStepFromProvider, getModelStepProvider } from "./provider";
import type { AskResult } from "./types";

// ----- Constants ------------------------------------------------------------

const SCHEMA = "dome.ask/v1";

// ----- Public types ---------------------------------------------------------

export type AskImpl = (question: string) => Promise<AskResult>;

export type CreateAskServerOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
  /** Bearer token every request must present. Must be non-empty. */
  readonly token: string;
  readonly model?: string | undefined;
  /**
   * Reject POST bodies larger than this with 413 `payload-too-large`
   * (default 1 MiB). Enforced on the declared `content-length` when present.
   */
  readonly maxBodyBytes?: number | undefined;
  /**
   * Inject a custom ask implementation (used by tests to avoid opening a real
   * vault). When omitted the default wires getModelStepProvider + runAsk.
   */
  readonly askImpl?: AskImpl | undefined;
};

export type AskServer = { readonly fetch: (request: Request) => Promise<Response> };

// ----- Helpers (private, mirrors src/http/server.ts) ------------------------

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(`${JSON.stringify(data, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, error: string, message: string): Response {
  return jsonResponse(status, { schema: SCHEMA, status: "error", error, message });
}

/** Constant-time bearer check: compare SHA-256 digests, never raw strings. */
function authorized(request: Request, tokenDigest: Buffer): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null || match[1] === undefined) return false;
  return timingSafeEqual(sha256(match[1]), tokenDigest);
}

// ----- Server factory -------------------------------------------------------

/**
 * Build the ask-server fetch handler. The caller owns the listener:
 * `dome ask-server` runs `Bun.serve({ fetch })`; tests call `.fetch()` directly.
 */
export function createAskServer(opts: CreateAskServerOptions): AskServer {
  if (opts.token.trim().length === 0) {
    throw new Error("createAskServer: token must be non-empty");
  }
  const tokenDigest = sha256(opts.token);
  const maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
  const enqueue = makeVaultMutex();

  // Default ask: open the vault, resolve the provider, run the loop.
  const defaultAsk: AskImpl = async (question) => {
    const prov = await getModelStepProvider(opts.vaultPath);
    if (prov.kind !== "ok") {
      throw new Error(
        prov.kind === "no-provider"
          ? "no model provider configured in .dome/config.yaml"
          : prov.message,
      );
    }
    const controller = new AbortController();
    const step = askStepFromProvider(prov.provider, {
      model: opts.model,
      signal: controller.signal,
    });
    const outcome = await withVaultShared(
      { path: opts.vaultPath, bundlesRoot: opts.bundlesRoot },
      (vault) => runAsk({ vault, step, question, model: opts.model }),
    );
    if (outcome.kind === "open-failed") {
      throw new Error(`vault open failed: ${openVaultErrorKind(outcome.error)}`);
    }
    return outcome.value;
  };

  const ask = opts.askImpl ?? defaultAsk;

  const routes = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /") {
      return jsonResponse(200, { schema: "dome.ask-server/v1", server: "dome-ask" });
    }

    if (route === "POST /ask") {
      // Body size gate: content-length fast-path.
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        return errorResponse(413, "payload-too-large", `request body exceeds the ${maxBodyBytes}-byte limit.`);
      }

      let body: { question?: unknown } | null = null;
      try {
        body = (await request.json()) as { question?: unknown };
      } catch {
        return errorResponse(400, "invalid-json", "request body is not valid JSON.");
      }

      const question =
        typeof body?.question === "string" ? body.question.trim() : "";
      if (question.length === 0) {
        return errorResponse(
          400,
          "ask-usage",
          "POST /ask requires a non-empty `question`.",
        );
      }

      try {
        const result = await ask(question);
        return jsonResponse(200, {
          schema: SCHEMA,
          status: "ok",
          answer: result.answer,
          citations: result.citations,
          steps: result.steps,
          stopReason: result.stopReason,
        });
      } catch (e) {
        return errorResponse(
          500,
          "ask-failed",
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    return errorResponse(404, "not-found", `no route for ${route}.`);
  };

  const handle = async (request: Request): Promise<Response> => {
    if (!authorized(request, tokenDigest)) {
      return jsonResponse(401, {
        schema: SCHEMA,
        status: "error",
        error: "unauthorized",
        message: "missing or invalid bearer token.",
      });
    }
    try {
      return await enqueue(() => routes(request));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(500, "internal", msg);
    }
  };

  return Object.freeze({ fetch: handle });
}
