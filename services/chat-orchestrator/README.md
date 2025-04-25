# Chat Orchestrator

A Cloudflare Worker that implements a RAG (Retrieval-Augmented Generation) graph for enhanced chat functionality.

## Overview

The Chat Orchestrator uses a state-machine-based approach to process chat messages, retrieve relevant context, and generate responses. It leverages the `@langchain/langgraph` library to create a directed graph of processing nodes.

## Features

- **Modular Architecture**: Each processing step is implemented as a separate node in the graph
- **Stateful Processing**: Maintains conversation context and intermediate results
- **Retrieval-Augmented Generation**: Enhances responses with relevant documents from the user's knowledge base
- **Tool Integration**: Can detect when tools are needed and incorporate their results
- **Streaming Responses**: Provides real-time updates via Server-Sent Events (SSE)
- **Persistence**: Uses D1 database for checkpointing and conversation resumption

## Graph Structure

The graph consists of the following nodes:

1. `split_rewrite`: Analyzes and potentially rewrites the user query
2. `retrieve`: Fetches relevant documents based on the query
3. `dynamic_widen`: Expands search parameters when needed
4. `tool_router`: Determines if tools should be used
5. `run_tool`: Executes specific tools
6. `generate_answer`: Creates the final response

## API

### POST /chat

Processes a chat message and returns a streaming response.

**Request:**

```json
{
  "initialState": {
    "messages": [
      {
        "role": "user",
        "content": "What do you know about Delaware?",
        "timestamp": 1714071234567
      }
    ],
    "userId": "user-123",
    "enhanceWithContext": true,
    "maxContextItems": 10,
    "includeSourceInfo": true,
    "maxTokens": 4000
  },
  "runId": "optional-conversation-id"
}
```

**Response:**

Server-Sent Events (SSE) stream with the following event types:

- `workflow_step`: Indicates the current processing step
- `answer`: Contains the generated response text and sources
- `done`: Signals the end of processing

## Development

```bash
# Install dependencies
pnpm install

# Run locally
pnpm dev

# Deploy
pnpm deploy
```

## Architecture

This service is part of the Dome platform and integrates with other services:

- Communicates with dome-api via RPC
- Uses D1 database for state persistence
- Implements streaming responses via SSE