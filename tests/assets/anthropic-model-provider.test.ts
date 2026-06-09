// Round-trip coverage for the shipped Anthropic provider template
// (`<SDK>/assets/model-providers/anthropic.ts`) — the file `dome init
// --with-model-provider anthropic` copies into vaults as
// `.dome/model-provider.ts`.
//
// This is the protocol lockstep test pinned by docs/wiki/specs/sdk-surface.md
// §"Model provider scaffold and probe": the template's stdout is validated
// against the SDK-side Zod response schemas (`parseModelProviderResponse`,
// `parseModelStepResponse`) and its probe answer against
// `probeCommandModelProvider`, so the template cannot change shape without
// the SDK-side contract agreeing.
//
// Hermetic by construction: the Anthropic Messages API is faked with a local
// Bun.serve and injected via ANTHROPIC_BASE_URL. The real API is never
// called.

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { resolveShippedModelProvidersRoot } from "../../src/cli/commands/sync-shared";
import { probeCommandModelProvider } from "../../src/engine/command-model-provider";
import {
  parseModelProviderResponse,
  parseModelStepResponse,
} from "../../src/engine/model-invoke";

const TEMPLATE_PATH = join(
  resolveShippedModelProvidersRoot(),
  "anthropic.ts",
);

type CapturedRequest = {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
};

type FakeAnthropic = {
  readonly url: string;
  readonly requests: CapturedRequest[];
  readonly stop: () => void;
};

const servers: FakeAnthropic[] = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop();
  }
});

function fakeAnthropic(
  respond: (body: Record<string, unknown>) => Response,
): FakeAnthropic {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      requests.push({
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      });
      return respond(body);
    },
  });
  const fake: FakeAnthropic = {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
  servers.push(fake);
  return fake;
}

function messagesResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

async function runTemplate(
  envelope: unknown,
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    // Deterministic baseline: no inherited key/model/pricing leakage.
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_MODEL: undefined,
    ANTHROPIC_MAX_TOKENS: undefined,
    ANTHROPIC_BASE_URL: undefined,
    ANTHROPIC_INPUT_COST_PER_MTOK: undefined,
    ANTHROPIC_OUTPUT_COST_PER_MTOK: undefined,
    ...env,
  };
  const proc = Bun.spawn([process.execPath, TEMPLATE_PATH], {
    env: childEnv,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(envelope));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("assets/model-providers/anthropic.ts", () => {
  test("request/v1: response validates against the SDK Zod schema; sonnet default; cost from built-in price table", async () => {
    const fake = fakeAnthropic(() =>
      messagesResponse({
        content: [{ type: "text", text: "hello from the fake API" }],
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1_000, output_tokens: 2_000 },
      }),
    );

    const run = await runTemplate(
      {
        schema: "dome.model-provider.request/v1",
        prompt: "Summarize the vault",
      },
      { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: fake.url },
    );
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);

    // The critical assertion: the template's stdout parses through the
    // actual SDK-side schema the engine uses.
    const response = parseModelProviderResponse(JSON.parse(run.stdout));
    expect(response.text).toBe("hello from the fake API");
    expect(response.model).toBe("claude-sonnet-4-6");
    // 1000/1M * $3 + 2000/1M * $15 = 0.003 + 0.03
    expect(response.costUsd).toBeCloseTo(0.033, 10);

    // Wire shape sent to the (fake) Anthropic Messages API.
    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0];
    if (sent === undefined) throw new Error("expected one request");
    expect(sent.path).toBe("/v1/messages");
    expect(sent.headers["x-api-key"]).toBe("sk-test");
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent.body.model).toBe("claude-sonnet-4-6");
    expect(sent.body.max_tokens).toBe(8192);
    expect(sent.body.temperature).toBe(0);
    expect(sent.body.messages).toEqual([
      { role: "user", content: "Summarize the vault" },
    ]);
  });

  test("request/v1: envelope model and temperature override the defaults", async () => {
    const fake = fakeAnthropic(() =>
      messagesResponse({
        content: [{ type: "text", text: "ok" }],
        model: "claude-haiku-4-5",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
    );

    const run = await runTemplate(
      {
        schema: "dome.model-provider.request/v1",
        prompt: "hi",
        model: "claude-haiku-4-5",
        temperature: 0.7,
      },
      { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: fake.url },
    );
    expect(run.exitCode).toBe(0);
    const response = parseModelProviderResponse(JSON.parse(run.stdout));
    // Haiku 4.5 pricing: $1 in / $5 out per MTok.
    expect(response.costUsd).toBeCloseTo(6, 10);
    expect(fake.requests[0]?.body.model).toBe("claude-haiku-4-5");
    expect(fake.requests[0]?.body.temperature).toBe(0.7);
  });

  test("request/v1: unknown model omits costUsd unless env prices are set", async () => {
    const fake = fakeAnthropic(() =>
      messagesResponse({
        content: [{ type: "text", text: "ok" }],
        model: "future-model-x",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      }),
    );

    const withoutPrices = await runTemplate(
      {
        schema: "dome.model-provider.request/v1",
        prompt: "hi",
        model: "future-model-x",
      },
      { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: fake.url },
    );
    expect(withoutPrices.exitCode).toBe(0);
    expect(
      parseModelProviderResponse(JSON.parse(withoutPrices.stdout)).costUsd,
    ).toBeUndefined();

    const withPrices = await runTemplate(
      {
        schema: "dome.model-provider.request/v1",
        prompt: "hi",
        model: "future-model-x",
      },
      {
        ANTHROPIC_API_KEY: "sk-test",
        ANTHROPIC_BASE_URL: fake.url,
        ANTHROPIC_INPUT_COST_PER_MTOK: "2",
        ANTHROPIC_OUTPUT_COST_PER_MTOK: "10",
      },
    );
    expect(withPrices.exitCode).toBe(0);
    expect(
      parseModelProviderResponse(JSON.parse(withPrices.stdout)).costUsd,
    ).toBeCloseTo(2, 10);
  });

  test("step/v1: tool_use/tool_result mapping round-trips through the SDK step schema", async () => {
    const fake = fakeAnthropic(() =>
      messagesResponse({
        content: [
          { type: "text", text: "Reading the page now." },
          {
            type: "tool_use",
            id: "toolu_01",
            name: "readPage",
            input: { path: "wiki/a.md" },
          },
        ],
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 500, output_tokens: 100 },
      }),
    );

    const run = await runTemplate(
      {
        schema: "dome.model-provider.step/v1",
        messages: [
          { role: "system", content: "You are the ingest agent." },
          { role: "user", content: "File this capture." },
          {
            role: "assistant",
            content: "Checking the index first.",
            toolCalls: [
              { id: "toolu_00", name: "readPage", input: { path: "index.md" } },
            ],
          },
          {
            role: "tool",
            toolCallId: "toolu_00",
            toolName: "readPage",
            content: "# Index\n- [[a]]",
          },
        ],
        tools: [
          {
            name: "readPage",
            description: "Read a vault page",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
      { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: fake.url },
    );
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);

    // SDK-side schema validates the template's step response.
    const response = parseModelStepResponse(JSON.parse(run.stdout));
    expect(response.text).toBe("Reading the page now.");
    expect(response.toolCalls).toEqual([
      { id: "toolu_01", name: "readPage", input: { path: "wiki/a.md" } },
    ]);
    expect(response.model).toBe("claude-sonnet-4-6");
    expect(response.costUsd).toBeCloseTo(0.003, 10);

    // The provider-neutral step request maps faithfully onto the Anthropic
    // Messages wire format.
    const sent = fake.requests[0];
    if (sent === undefined) throw new Error("expected one request");
    expect(sent.body.system).toBe("You are the ingest agent.");
    expect(sent.body.tools).toEqual([
      {
        name: "readPage",
        description: "Read a vault page",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
    expect(sent.body.messages).toEqual([
      { role: "user", content: "File this capture." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking the index first." },
          {
            type: "tool_use",
            id: "toolu_00",
            name: "readPage",
            input: { path: "index.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_00",
            content: "# Index\n- [[a]]",
          },
        ],
      },
    ]);
  });

  test("probe/v1: responsive via probeCommandModelProvider, no network call, key present", async () => {
    const fake = fakeAnthropic(() => {
      throw new Error("the probe must not call the API");
    });

    const result = await probeCommandModelProvider(
      { kind: "command", command: [process.execPath, TEMPLATE_PATH] },
      {
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "sk-test",
          ANTHROPIC_BASE_URL: fake.url,
          ANTHROPIC_MODEL: undefined,
        },
      },
    );
    expect(result).toEqual({
      status: "responsive",
      provider: "anthropic",
      keyPresent: true,
      defaultModel: "claude-sonnet-4-6",
    });
    expect(fake.requests).toHaveLength(0);
  });

  test("probe/v1: succeeds without a key and reports keyPresent false", async () => {
    const result = await probeCommandModelProvider(
      { kind: "command", command: [process.execPath, TEMPLATE_PATH] },
      {
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_MODEL: undefined,
        },
      },
    );
    expect(result).toEqual({
      status: "responsive",
      provider: "anthropic",
      keyPresent: false,
      defaultModel: "claude-sonnet-4-6",
    });
  });

  test("request/v1 without a key fails loudly", async () => {
    const run = await runTemplate(
      { schema: "dome.model-provider.request/v1", prompt: "hi" },
      {},
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("ANTHROPIC_API_KEY is required");
  });

  test("API errors surface with status and body excerpt", async () => {
    const fake = fakeAnthropic(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          }),
          { status: 529 },
        ),
    );

    const run = await runTemplate(
      { schema: "dome.model-provider.request/v1", prompt: "hi" },
      { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: fake.url },
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Anthropic request failed 529");
    expect(run.stderr).toContain("Overloaded");
  });

  test("unknown envelope schema is rejected with a non-zero exit", async () => {
    const run = await runTemplate({ schema: "dome.model-provider.future/v9" }, {
      ANTHROPIC_API_KEY: "sk-test",
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "unsupported Dome model provider request schema",
    );
  });
});
