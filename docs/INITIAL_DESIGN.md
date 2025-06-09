Below is a TypeScript-first design-doc for a Retrieval-Augmented Generation
(RAG) platform that ingests live data from GitHub, Notion, Slack and Linear,
stores richly-chunked embeddings in a hybrid vector store, and serves answers
through an agentic pipeline built with LangGraph + LangChain JS. It preserves
the architecture you liked while swapping every critical path to clean, typed
Node code and well-supported JS libraries.

---

## 0 Quick-take

A cluster of source connectors written in TypeScript streams webhook or cursor
events into Kafka, where lightweight ingestion workers use **LlamaIndex TS** to
normalise and chunk payloads. Embeddings are produced with the OpenAI Node SDK
and up-serted into **Weaviate** (prod) or **Chroma** (local) via their
TypeScript clients. Queries hit a **LangGraph.js** ReAct agent whose main “tool”
is a **QueryPipeline** built from LlamaIndex documents, giving tight control
over rewrite → retrieve → rerank → synthesise steps. Everything is observable in
LangSmith, typed end-to-end, and deployable as Docker images or serverless
functions. ([ts.llamaindex.ai][1], [js.langchain.com][2])

---

## 1 Goals & non-goals

| Goal                                                          | Non-goal                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| Answer deeply technical questions with < 1 s P95 latency.     | Full-text archival of every event (handled by existing log storage). |
| Ingest GitHub, Notion, Slack, Linear within \~60 s of change. | Building custom embedding models from scratch.                       |
| Modular, typed codebase that teams can extend.                | Supporting sources that lack stable APIs today.                      |

---

## 2 High-level architecture

```text
        GitHub / Notion / Slack / Linear
                    │  (webhooks / cursors)
┌───────────────────▼─────────────────────────────────────────┐
│  Source Connector Pods  (@octokit/webhooks, notion-sdk-js, │
│  Bolt-JS, @linear/sdk)                                     │
└───────────────┬──────────────────────────────┬─────────────┘
                ▼                              ▼
     Kafka topics (node-rdkafka)    Retry DLQ (Kafka)
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Ingestion Workers  (LlamaIndex.TS + Zod validation)       │
│  • normalise → chunk → embed                               │
└───────────────┬──────────────────────────────┬─────────────┘
                │vectors                      │metadata
        ┌───────▼─────────────┐      ┌────────▼─────────┐
        │Vector DB (Weaviate) │      │ Postgres / S3    │
        └────────┬────────────┘      └──────────────────┘
                 ▼
      LangGraph.js ReAct Agent (LangChain.JS tools)
                 ▼
        Fastify / tRPC API  + Slack slash-command bot
```

---

## 3 Data ingestion layer

### 3.1 Connectors

| Source     | Library             | Notes                                                                              |
| ---------- | ------------------- | ---------------------------------------------------------------------------------- |
| **GitHub** | `@octokit/webhooks` | Typed helper to verify HMAC & route events. ([github.com][3])                      |
| **Notion** | `@notionhq/client`  | Cursor-based sync with built-in TypeScript types. ([github.com][4])                |
| **Slack**  | `@slack/bolt`       | Event API handler with socket-mode option. ([tools.slack.dev][5], [github.com][6]) |
| **Linear** | `@linear/sdk`       | Typed GraphQL SDK plus webhooks. ([linear.app][7], [npmjs.com][8])                 |

All connectors publish the raw JSON to Kafka via **node-rdkafka**, giving
at-least-once delivery and back-pressure-aware scaling. ([github.com][9])

### 3.2 Normalisation & chunking

```ts
import { GithubWebhookEvent } from '@octokit/webhooks-types';
import { Document, RecursiveCharacterTextSplitter } from 'llamaindex';
export async function normalise(
  event: GithubWebhookEvent
): Promise<Document[]> {
  const doc = new Document({
    text: event.pull_request?.body ?? '',
    metadata: { url: event.pull_request?.html_url, sha: event.after },
  });
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 400 });
  return splitter.splitDocuments([doc]);
}
```

LlamaIndex.TS gives us the same `Document`/`Node` abstractions you saw in
Python, but typed. ([ts.llamaindex.ai][1])

Chunks carry `orgId`, `sourceUrl`, permissions, and (for code)
`{repo, path, blobSha}` so superseded nodes can be soft-versioned.

---

## 4 Embeddings & vector store

- **OpenAI `text-embedding-3-small`** via `openai` Node SDK for the default
  1536-D embedding. ([platform.openai.com][10])
- **Fallback local model**: `bge-small-en` served through Ollama and accessed
  with LangChain JS `ChatOllama`.

### 4.1 Vector DB options

| DB           | TS client            | Strengths                                                 |
| ------------ | -------------------- | --------------------------------------------------------- |
| **Weaviate** | `weaviate-ts-client` | Hybrid BM25+dense, auto-sharding. ([weaviate.io][11])     |
| **Chroma**   | `chromadb`           | Embedded dev mode, simple API. ([docs.trychroma.com][12]) |
| **Qdrant**   | `@qdrant/qdrant-js`  | High recall/QPS, gRPC option. ([github.com][13])          |

Hybrid scoring uses Weaviate’s `bm25` + `vector` with `returnMetadata=true` so
the agent gets citations for free.

---

## 5 Retrieval & ranking pipeline

We keep the same four-stage flow but wire it in **LlamaIndex QueryPipeline** (JS
flavour):

```ts
import { QueryPipeline } from '@llamaindex/pipelines';
export const pipeline = await QueryPipeline.fromConfig(
  'pipelines/tech-qa.yaml'
);
```

- **Rewrite** – a LangChain `PromptTemplate` that expands acronyms.
- **Retrieve** – hybrid vector search (`k=8`).
- **Rerank** – `bge-reranker-base` cross-encoder via HuggingFace.ts.
- **Synthesise** – OpenAI `gpt-4o-mini` with source-citations in the prompt.

QueryPipeline YAML keeps configs declarative for ops to tweak without redeploy.
([js.langchain.com][2], [ts.llamaindex.ai][1])

---

## 6 Agent orchestration

### 6.1 LangGraph.js ReAct agent

LangGraph’s JS port lets us model the loop in a type-safe graph with
checkpointing. ([github.com][14], [langchain-ai.github.io][15])

```ts
import { StateGraph } from '@langchain/langgraph';
import { ragQueryTool } from './tools/rag';
const g = new StateGraph<{ question: string }>();
g.addNode('search', ragQueryTool);
g.addNode('think', llmReasonNode);
g.addConditionalEdges('think', { done: 'output', needs_search: 'search' });
export const agent = g.compile();
```

A ready-made ReAct template is published by LangGraph and can be extended with
tools (GitHub diff fetch, Linear ticket lookup). ([github.com][16])

### 6.2 Tool wrapper example

```ts
import { Tool } from '@langchain/core';
export const ragQueryTool = new Tool({
  name: 'rag_query',
  description: 'Answer using indexed knowledge',
  func: (q: string) => pipeline.run({ question: q }),
});
```

LangChain takes care of JSON-schema validation on tool I/O. ([airbyte.com][17])

---

## 7 Deployment & operations

| Component         | Packaging                             | Scaling cue         |
| ----------------- | ------------------------------------- | ------------------- |
| Connectors        | Docker images, k8s Deployments        | Kafka lag per topic |
| Ingestion workers | Node 20, worker pool                  | CPU & queue depth   |
| Embedding service | Ray Serve (GPU) or serverless lambdas | GPU utilisation     |
| Vector DB         | Weaviate cluster with Raft            | Query QPS           |
| Agent API         | Fastify pods with Autoscaling         | CPU & P95 latency   |

Observability: LangSmith traces every LLM/tool call; Fastify exposes Prometheus
metrics.

---

## 8 Security & governance

- **Signature verification** using `webhooks.verify()` for GitHub,
  `app.receiver` for Bolt, and HMAC headers for Linear. ([github.com][3],
  [tools.slack.dev][5], [linear.app][7])
- Secrets stored in HashiCorp Vault; injected via env-vars at runtime.
- Row-level ACL on vectors (`orgId`, `visibility`).
- Periodic DLP scan of stored chunks with GCP Sensitive Data Protection API.

---

## 9 Extensibility patterns

1. **Connector interface**

```ts
export interface Connector<T> {
  name: string;
  handle(event: T): Promise<void>;
}
```

2. **YAML-driven pipelines** – swap rerankers or add filters with a config
   change.
3. **Feature flags** – LaunchDarkly toggles new models by org.

---

## 10 Critical code snippets

### 10.1 GitHub webhook → Kafka

````ts
import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import Kafka from "node-rdkafka";

const webhooks = new Webhooks({ secret: process.env.GH_SECRET! });
const producer = new Kafka.Producer({ "metadata.broker.list": process.env.KAFKA! });
producer.connect();

webhooks.onAny(({ id, name, payload }) => {
  producer.produce("github_events", null, Buffer.from(JSON.stringify(payload)), id);
});

export const middleware = createNodeMiddleware(webhooks);
``` :contentReference[oaicite:17]{index=17}

### 10.2  Chunk & upsert

```ts
const nodes = await normalise(event);
await weaviateClient.batch.objectsBatcher()
  .withObjects(nodes.map(toWeaviateObj))
  .do();
``` :contentReference[oaicite:18]{index=18}

### 10.3  Query from Slack slash command

```ts
app.command("/ask", async ({ ack, respond, command }) => {
  await ack();
  const answer = await agent.invoke({ question: command.text });
  await respond(answer);
});
``` :contentReference[oaicite:19]{index=19}

---

## 11  Recommended stack (TS edition)

| Concern | Library / Service |
|---------|-------------------|
|Source connectors|`@octokit/webhooks`, `@notionhq/client`, `@slack/bolt`, `@linear/sdk`|
|Ingestion & RAG|`llamaindex` **TS**, `langchain` **JS**|
|Agent orchestrator|`@langchain/langgraph`|
|Embeddings|`openai` Node SDK|
|Vector store|Weaviate (`weaviate-ts-client`), Chroma (`chromadb`), Qdrant (`@qdrant/qdrant-js`)|
|Queue|Kafka (`node-rdkafka`)|
|API layer|Fastify + tRPC|
|Observability|LangSmith, Prometheus|

---

## 12  Roadmap

1. **Week 1–2**: GitHub connector → Chroma; single-shot RAG.
2. **Week 3–4**: Add Slack & Notion connectors; enforce ACL tags.
3. **Week 5**: Replace single-shot with LangGraph ReAct agent; wire live GitHub diff tool.
4. **Week 6**: Production hardening (autoscaling, DLP scans, chaos tests).

---

By pivoting the entire stack to TypeScript we get strict types, unified tooling, and first-class Node libraries for every layer—from webhooks to vector DB to agent orchestration—without sacrificing the modular, best-practice RAG architecture you asked for.
::contentReference[oaicite:20]{index=20}
````

[1]: https://ts.llamaindex.ai/?utm_source=chatgpt.com 'LlamaIndex.TS'
[2]:
  https://js.langchain.com/docs/concepts/rag/?utm_source=chatgpt.com
  'Retrieval augmented generation (rag) - LangChain.js'
[3]:
  https://github.com/octokit/webhooks.js/?utm_source=chatgpt.com
  'octokit/webhooks.js: GitHub webhook events toolset for Node.js'
[4]:
  https://github.com/makenotion/notion-sdk-js?utm_source=chatgpt.com
  'makenotion/notion-sdk-js: Official Notion JavaScript Client - GitHub'
[5]:
  https://tools.slack.dev/bolt-js/reference/?utm_source=chatgpt.com
  'Bolt for JavaScript interface and configuration reference'
[6]:
  https://github.com/slackapi/bolt-js/blob/main/examples/getting-started-typescript/src/app.ts?utm_source=chatgpt.com
  'bolt-js/examples/getting-started-typescript/src/app.ts at main - GitHub'
[7]: https://linear.app/developers?utm_source=chatgpt.com 'Linear Developers'
[8]:
  https://www.npmjs.com/package/%40linear/sdk?utm_source=chatgpt.com
  '@linear/sdk - npm'
[9]:
  https://github.com/Blizzard/node-rdkafka?utm_source=chatgpt.com
  'Blizzard/node-rdkafka: Node.js bindings for librdkafka - GitHub'
[10]:
  https://platform.openai.com/docs/api-reference/embeddings/object?utm_source=chatgpt.com
  'API Reference - OpenAI Platform'
[11]:
  https://weaviate.io/developers/weaviate/client-libraries/typescript?utm_source=chatgpt.com
  'JavaScript and TypeScript - Weaviate'
[12]:
  https://docs.trychroma.com/reference/js/client?utm_source=chatgpt.com
  'JS Client - Chroma Docs'
[13]:
  https://github.com/qdrant/qdrant-js?utm_source=chatgpt.com
  'JavaScript/Typescript SDK for Qdrant Vector Database - GitHub'
[14]:
  https://github.com/langchain-ai/langgraphjs?utm_source=chatgpt.com
  'langchain-ai/langgraphjs: Framework to build resilient ... - GitHub'
[15]:
  https://langchain-ai.github.io/langgraphjs/tutorials/quickstart/?utm_source=chatgpt.com
  'LangGraph.js - Quickstart'
[16]:
  https://github.com/langchain-ai/react-agent-js?utm_source=chatgpt.com
  'langchain-ai/react-agent-js - GitHub'
[17]:
  https://airbyte.com/data-engineering-resources/using-langchain-react-agents?utm_source=chatgpt.com
  'Using LangChain ReAct Agents to Answer Complex Questions'
