# Dome API Service

## Overview

The Dome API Service is a Cloudflare Worker that serves as the primary interface for client applications to interact with the Dome system. It provides endpoints for managing notes, performing vector searches, and handling user data.

The service has been recently refactored to integrate with the Constellation embedding service, which provides a more robust and scalable approach to text embedding and vector search operations.

## Features

- **Note Management**: Create, read, update, and delete notes
- **Vector Search**: Find semantically similar notes using vector embeddings
- **User Management**: Handle user authentication and data
- **Constellation Integration**: Seamless integration with the Constellation embedding service
- **Asynchronous Processing**: Offload embedding operations to background processing
- **Typed Interfaces**: Strong typing throughout the codebase for better reliability

## Architecture

The Dome API Service follows a layered architecture:

```
┌─────────────────────────────────────────────────────────┐
│                     API Endpoints                        │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│                     Service Layer                        │
│                                                         │
│  ┌─────────────────┐    ┌─────────────────────────────┐ │
│  │   Note Service  │    │  Constellation Service      │ │
│  └────────┬────────┘    └─────────────┬───────────────┘ │
│           │                           │                 │
└───────────┼───────────────────────────┼─────────────────┘
            │                           │
┌───────────▼───────────┐   ┌───────────▼───────────────┐
│      D1 Database      │   │ Constellation Worker      │
└─────────────────────┬─┘   │ (Service Binding)         │
                      │     └───────────┬───────────────┘
                      │                 │
                      │     ┌───────────▼───────────────┐
                      │     │      Vectorize Index      │
                      └────►│                           │
                            └───────────────────────────┘
```

### Key Components

1. **API Endpoints**: RESTful endpoints for client interactions
2. **Service Layer**: Business logic implementation
   - **Note Service**: Handles note CRUD operations
   - **Constellation Service**: Interface to the Constellation embedding service
3. **Data Layer**:
   - **D1 Database**: Stores note metadata and user information
   - **Vectorize Index**: Stores vector embeddings for semantic search (via Constellation)

## Constellation Integration

The Dome API Service integrates with the Constellation embedding service through a service binding, which provides a typed RPC interface for embedding and vector search operations.

### Benefits of the Integration

- **Separation of Concerns**: Embedding and vector search logic is encapsulated in a dedicated service
- **Scalability**: Asynchronous processing of embedding jobs through queues
- **Performance**: Offloading heavy AI operations from the user-facing API
- **Maintainability**: Centralized embedding logic makes updates and improvements easier

### How It Works

1. **Creating/Updating Notes**:

   - When a note is created or updated, the API service enqueues an embedding job
   - The job is processed asynchronously by the Constellation service
   - The embedding is stored in the Vectorize index with metadata

2. **Searching Notes**:
   - When a search is performed, the API service calls the Constellation service
   - Constellation performs the vector search and returns the results
   - The API service enriches the results with additional data from the database

## Usage

### Service Binding

To use the Constellation service, the following binding is configured in `wrangler.toml`:

```toml
[[services]]
binding   = "CONSTELLATION"
service   = "constellation"
environment = "production"
```

### Enqueuing Embedding Jobs

```typescript
// When a note is created or updated
await env.EMBED_QUEUE.send({
  userId: note.userId,
  noteId: note.id,
  text: note.content,
  created: Date.now(),
  version: 1,
});
```

### Performing Vector Searches

```typescript
// Search for similar notes
const results = await env.CONSTELLATION.query(
  searchText,
  { userId: currentUser.id }, // Filter by user
  10, // Return top 10 results
);

// Process results
const noteIds = results.map(result => result.metadata.noteId);
const notes = await noteService.getByIds(noteIds);
```

## Setup and Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [pnpm](https://pnpm.io/) package manager
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (v4 or later)
- Cloudflare account with Workers, D1, and service bindings access

### Installation

1. **Clone the repository and install dependencies**:

   ```bash
   git clone https://github.com/example/dome-cf.git
   cd dome-cf
   pnpm install
   ```

2. **Set up environment variables**:

   Create a `.dev.vars` file in the `services/dome-api` directory:

   ```
   VERSION=1.0.0
   ENVIRONMENT=development
   LOG_LEVEL=debug
   ```

3. **Run the service locally**:

   ```bash
   cd services/dome-api
   pnpm dev
   ```

## Development

### Local Development

1. **Start the local development server**:

   ```bash
   cd services/dome-api
   pnpm dev
   ```

2. **Run tests**:

   ```bash
   pnpm test
   ```

3. **Lint code**:

   ```bash
   pnpm lint
   ```

### Deployment

Deploy to different environments:

```bash
# Deploy to staging
pnpm deploy:staging

# Deploy to production
pnpm deploy:prod
```

## Troubleshooting

### Common Issues

1. **Embedding Not Working**:

   - Check if the Constellation service is running
   - Verify the service binding is correctly configured
   - Check the queue depth for embedding jobs

2. **Search Not Returning Expected Results**:

   - Verify the note has been embedded (check Vectorize index)
   - Check if the search query is properly formatted
   - Ensure metadata filters are correctly applied

3. **Performance Issues**:
   - Monitor queue depth for embedding jobs
   - Check Constellation service metrics
   - Consider adjusting batch sizes or concurrency

## Migration from Legacy Architecture

The integration with Constellation replaces the previous direct embedding approach. The main changes include:

1. **Embedding Process**:

   - Old: Direct embedding in the API service using Workers AI
   - New: Asynchronous embedding through Constellation queue

2. **Vector Search**:

   - Old: Direct Vectorize calls from the API service
   - New: RPC calls to the Constellation service

3. **Error Handling**:
   - Old: Limited retry logic in the API service
   - New: Robust error handling with dead letter queues in Constellation

For detailed migration steps, see the [Constellation Migration Plan](../constellation/MIGRATION.md).
