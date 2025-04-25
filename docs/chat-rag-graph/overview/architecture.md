# Architecture Overview

The Chat RAG Graph solution is built on a modular, graph-based architecture that enables flexible, dynamic processing of user queries. This document provides a high-level overview of the system architecture, including its key components and their interactions.

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Chat RAG Graph System                           │
│                                                                         │
│  ┌───────────┐     ┌───────────────────────────────────────────────┐    │
│  │           │     │            Graph Execution Engine              │    │
│  │  API      │     │                                               │    │
│  │  Layer    │◄────┤  ┌─────────┐  ┌─────────┐  ┌─────────┐        │    │
│  │           │     │  │ Split/  │  │         │  │ Generate│        │    │
│  │  - Hono   │     │  │ Rewrite ├─►│Retrieve ├─►│ Answer  │        │    │
│  │  - REST   │     │  │  Node   │  │  Node   │  │  Node   │        │    │
│  │  - SSE    │     │  └─────────┘  └────┬────┘  └─────────┘        │    │
│  └─────┬─────┘     │                    │                          │    │
│        │           │                    ▼                          │    │
│        │           │  ┌─────────┐  ┌────────┐   ┌─────────┐        │    │
│        │           │  │ Dynamic │  │ Route  │   │  Tool   │        │    │
│        │           │  │  Widen  │◄─┤ After  │   │ Router  │        │    │
│        │           │  │  Node   │  │Retrieve│──►│  Node   │        │    │
│        │           │  └─────────┘  └────────┘   └────┬────┘        │    │
│        │           │                                 │              │    │
│        │           │                                 ▼              │    │
│        │           │                            ┌────────┐          │    │
│        │           │                            │  Run   │          │    │
│        │           │                            │  Tool  │          │    │
│        │           │                            │  Node  │          │    │
│        │           │                            └────────┘          │    │
│        │           └───────────────────────────────────────────────┘    │
│        │                                                                 │
│        │           ┌───────────────────────────────────────────────┐    │
│        │           │                External Services               │    │
│        │           │                                               │    │
│        │           │  ┌─────────┐  ┌─────────┐  ┌─────────┐        │    │
│        └──────────►│  │  LLM    │  │ Vector  │  │ External│        │    │
│                    │  │ Service │  │   DB    │  │  Tools  │        │    │
│                    │  │         │  │         │  │         │        │    │
│                    │  └─────────┘  └─────────┘  └─────────┘        │    │
│                    │                                               │    │
│                    └───────────────────────────────────────────────┘    │
│                                                                         │
│                    ┌───────────────────────────────────────────────┐    │
│                    │              Support Services                  │    │
│                    │                                               │    │
│                    │  ┌─────────┐  ┌─────────┐  ┌─────────┐        │    │
│                    │  │ State   │  │ Observ- │  │ Security│        │    │
│                    │  │Checkpt. │  │ ability │  │ Services│        │    │
│                    │  │         │  │         │  │         │        │    │
│                    │  └─────────┘  └─────────┘  └─────────┘        │    │
│                    │                                               │    │
│                    └───────────────────────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. API Layer

The API layer provides the interface for client applications to interact with the Chat RAG Graph system. It includes:

- **REST API**: Handles synchronous chat requests and responses
- **SSE Endpoints**: Provides streaming responses for real-time updates
- **Authentication**: Validates user identity and permissions
- **Request Validation**: Ensures requests meet required format and content standards

### 2. Graph Execution Engine

The core of the system is the graph execution engine, which orchestrates the flow of processing through various specialized nodes:

- **Split/Rewrite Node**: Analyzes and potentially rewrites user queries to improve retrieval
- **Retrieve Node**: Fetches relevant documents from knowledge sources
- **Route After Retrieve Node**: Determines next steps based on retrieval results
- **Dynamic Widen Node**: Adjusts search parameters when initial results are insufficient
- **Tool Router Node**: Identifies and routes to appropriate tools
- **Run Tool Node**: Executes external tools and captures results
- **Generate Answer Node**: Creates the final response using retrieved information and tool results

### 3. External Services

The system integrates with several external services:

- **LLM Service**: Provides natural language understanding and generation capabilities
- **Vector Database**: Stores and retrieves embeddings for semantic search
- **External Tools**: Specialized capabilities like calculators, web search, etc.

### 4. Support Services

Several supporting services ensure the system operates reliably and securely:

- **State Checkpointing**: Persists execution state for reliability and recovery
- **Observability**: Logging, metrics, and tracing for monitoring and debugging
- **Security Services**: Authentication, authorization, and data protection

## Data Flow

1. User sends a query through the API layer
2. The query is processed by the Split/Rewrite node to optimize for retrieval
3. The Retrieve node fetches relevant documents from the vector database
4. Based on retrieval results, the system either:
   - Widens search parameters if results are insufficient
   - Routes to appropriate tools if tool intent is detected
   - Proceeds directly to answer generation if sufficient context is available
5. If tools are needed, the Tool Router selects the appropriate tool(s)
6. The Run Tool node executes the selected tool(s) and captures results
7. The Generate Answer node creates a response using retrieved documents and tool results
8. The response is returned to the user through the API layer

## State Management

Throughout the execution flow, the system maintains and transforms a state object that includes:

- User information
- Conversation history
- Retrieved documents
- Tool results
- Generated content
- Execution metadata

This state is checkpointed at key points to enable recovery in case of failures and to support long-running conversations.

## Deployment Architecture

The Chat RAG Graph system is deployed as a set of Cloudflare Workers, leveraging the edge computing model for low-latency, globally distributed processing. Key aspects of the deployment architecture include:

- **Edge Deployment**: Core processing runs on Cloudflare's global edge network
- **Stateless Design**: Workers are stateless, with state persisted in D1 databases
- **Durable Objects**: Used for coordination when needed
- **R2 Storage**: Stores large documents and binary assets
- **Vectorize**: Provides vector search capabilities for document retrieval

This architecture enables high performance, scalability, and reliability while minimizing operational complexity.