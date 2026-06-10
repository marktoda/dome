// Scripted fake model for the capture→ingest→captured-block scenario.
//
// A `dome.model-provider.step/v1` command provider (each step is a fresh
// process — state is reconstructed from the message history): drives the
// ingest agent through exactly three steps per source:
//
//   1. appendToPage(today's daily, one `- [ ] #task …` line)
//   2. archiveSource(the raw inbox path)
//   3. final text (no tool call) → the loop ends
//
// The daily path and raw path are parsed from the task turn, so the script
// is timezone- and config-agnostic. Probe and plain-text request envelopes
// are answered cheaply so doctor/text callers can't wedge the scenario.

export {};

type Message = {
  readonly role: string;
  readonly content: string;
  readonly toolName?: string;
};

type StepRequest = {
  readonly schema: string;
  readonly messages?: ReadonlyArray<Message>;
};

const TASK_LINE = "- [ ] #task call the landlord about the radiator";

const raw = await Bun.stdin.text();
const request = JSON.parse(raw) as StepRequest;

if (request.schema === "dome.model-provider.probe/v1") {
  respond({ schema: "dome.model-provider.probe/v1", ok: true, provider: "scripted" });
} else if (request.schema === "dome.model-provider.request/v1") {
  respond({ text: "scripted", costUsd: 0.0001 });
} else if (request.schema === "dome.model-provider.step/v1") {
  const messages = request.messages ?? [];
  const task = messages.find((m) => m.role === "user")?.content ?? "";
  const dailyPath = /^Today's daily note path: (\S+)/m.exec(task)?.[1];
  const rawPath = /^Raw source path: (\S+)/m.exec(task)?.[1];
  if (dailyPath === undefined || rawPath === undefined) {
    // Some other agent (the brief, consolidate, …) fired on a schedule tick:
    // answer with a no-tool-call final turn so it ends quietly — this script
    // drives only the ingest flow.
    respond({ text: "no action", costUsd: 0.0001 });
    process.exit(0);
  }
  const called = new Set(
    messages.filter((m) => m.role === "tool").map((m) => m.toolName ?? ""),
  );
  if (!called.has("appendToPage")) {
    respond({
      toolCalls: [
        {
          id: "t1",
          name: "appendToPage",
          input: { path: dailyPath, content: TASK_LINE },
        },
      ],
      costUsd: 0.0001,
    });
  } else if (!called.has("archiveSource")) {
    respond({
      toolCalls: [
        { id: "t2", name: "archiveSource", input: { rawPath } },
      ],
      costUsd: 0.0001,
    });
  } else {
    respond({ text: "captured task routed; source archived.", costUsd: 0.0001 });
  }
} else {
  console.error(`captured-ingest-step: unknown schema ${request.schema}`);
  process.exit(1);
}

function respond(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload));
}
