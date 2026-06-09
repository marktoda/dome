// Tool bindings for the ingest agent. Each tool's execute reads through the
// injected reader (ctx.snapshot in production) and mutates AgentRunState. The
// reader is the test seam.

import type { AgentRunState, AgentTool } from "./agent-loop";

export type VaultReader = {
  readonly readFile: (path: string) => Promise<string | null>;
  readonly listMarkdownFiles: () => Promise<ReadonlyArray<string>>;
};

const STRING = { type: "string" } as const;

// Cap a single readPage result so one large page cannot blow the agent's
// context budget. The harness also trims accumulated history (see agent-loop),
// but bounding each read keeps any single step small.
const MAX_READ_CHARS = 20_000;

function capRead(content: string): string {
  if (content.length <= MAX_READ_CHARS) return content;
  return `${content.slice(0, MAX_READ_CHARS)}\n…[truncated ${content.length - MAX_READ_CHARS} chars — read a more specific section if needed]`;
}

function objectSchema(
  props: Record<string, unknown>,
  required: ReadonlyArray<string>,
): Readonly<Record<string, unknown>> {
  return { type: "object", properties: props, required, additionalProperties: false };
}

async function currentContent(
  path: string,
  state: AgentRunState,
  reader: VaultReader,
): Promise<string | null> {
  const pending = state.edits.get(path);
  if (pending?.kind === "write") return pending.content;
  if (pending?.kind === "delete") return null;
  return reader.readFile(path);
}

export function makeIngestTools(opts: {
  readonly reader: VaultReader;
}): ReadonlyArray<AgentTool> {
  const { reader } = opts;
  return [
    {
      schema: {
        name: "readPage",
        description: "Read a vault file's current content. Returns null if absent.",
        inputSchema: objectSchema({ path: STRING }, ["path"]),
      },
      execute: async (input, state) => {
        const { path } = input as { path: string };
        const content = await currentContent(path, state, reader);
        return content === null ? `(no file at ${path})` : capRead(content);
      },
    },
    {
      schema: {
        name: "listPages",
        description: "List all readable markdown paths in the vault.",
        inputSchema: objectSchema({}, []),
      },
      execute: async () => (await reader.listMarkdownFiles()).join("\n"),
    },
    {
      schema: {
        name: "searchVault",
        description: "Find readable markdown paths whose content contains the query (case-insensitive).",
        inputSchema: objectSchema({ query: STRING }, ["query"]),
      },
      execute: async (input) => {
        const { query } = input as { query: string };
        const needle = query.toLowerCase();
        const hits: string[] = [];
        for (const path of await reader.listMarkdownFiles()) {
          const content = await reader.readFile(path);
          if (content !== null && content.toLowerCase().includes(needle)) {
            hits.push(path);
          }
          if (hits.length >= 25) break;
        }
        return hits.length === 0 ? "(no matches)" : hits.join("\n");
      },
    },
    {
      schema: {
        name: "writePage",
        description: "Create or fully replace a file. Read first when updating.",
        inputSchema: objectSchema({ path: STRING, content: STRING }, ["path", "content"]),
      },
      execute: async (input, state) => {
        const { path, content } = input as { path: string; content: string };
        state.edits.set(path, { kind: "write", path, content });
        return `wrote ${path}`;
      },
    },
    {
      schema: {
        name: "appendToPage",
        description: "Append a block to the end of a file (creates it if absent).",
        inputSchema: objectSchema({ path: STRING, content: STRING }, ["path", "content"]),
      },
      execute: async (input, state) => {
        const { path, content } = input as { path: string; content: string };
        const existing = await currentContent(path, state, reader);
        const next =
          existing === null || existing.trim() === ""
            ? content
            : `${existing.replace(/\s+$/, "")}\n${content}`;
        state.edits.set(path, { kind: "write", path, content: next });
        return `appended to ${path}`;
      },
    },
    {
      schema: {
        name: "archiveSource",
        description: "Move a consumed inbox/raw source to inbox/processed.",
        inputSchema: objectSchema({ rawPath: STRING }, ["rawPath"]),
      },
      execute: async (input, state) => {
        const { rawPath } = input as { rawPath: string };
        const body = (await currentContent(rawPath, state, reader)) ?? "";
        const processedPath = rawPath.replace(/^inbox\/raw\//, "inbox/processed/");
        state.edits.set(processedPath, {
          kind: "write",
          path: processedPath,
          content: body,
        });
        state.edits.set(rawPath, { kind: "delete", path: rawPath });
        return `archived ${rawPath} -> ${processedPath}`;
      },
    },
    {
      schema: {
        name: "askOwner",
        description: "Ask the owner a question when a claim is genuinely uncertain.",
        inputSchema: objectSchema({ question: STRING }, ["question"]),
      },
      execute: async (input, state) => {
        const { question } = input as { question: string };
        state.questions.push({
          question,
          idempotencyKey: `dome.agent.ingest:${question}`,
        });
        return "asked the owner";
      },
    },
  ];
}
