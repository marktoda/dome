# Dome Product Specification

## 1. Overview

Dome is a personal knowledge management system that allows users to store, search, and retrieve information using natural language. The system leverages Cloudflare's serverless infrastructure to provide a scalable, low-latency solution.

Key technologies:
  - **D1** for structured rows
  - **Vectorize** for embeddings (via Constellation service)
  - **R2** for large blobs
  - **Workers** for API and background processing
  - **Queues** for asynchronous operations
  - **Workers AI** for embeddings and LLM operations (via Constellation service)

## 2. User Experience

Users interact with Dome through:

1. **Web Interface**: A responsive web application
2. **Mobile App**: Native mobile applications for iOS and Android
3. **CLI**: Command-line interface for power users
4. **API**: RESTful API for integrations

## 3. Core Features

### 3.1. Note Management

- Create, read, update, delete notes
- Support for rich text, markdown, and code snippets
- File attachments (PDFs, images, etc.)
- Tagging and categorization
- Version history

### 3.2. Semantic Search

- Natural language search queries
- Vector-based similarity search
- Filtering by metadata (tags, date, etc.)
- Relevance ranking
- Real-time search suggestions

### 3.3. Knowledge Graph

- Automatic linking between related notes
- Visualization of connections
- Entity extraction and recognition
- Topic clustering

### 3.4. Integrations

- GitHub repositories
- Notion workspaces
- Google Drive
- Slack
- Email

## 4. Data Model

Each "note" in the system consists of:
   - row in **D1** (`notes`, `tasks`, `reminders`)
   - embedding in **Vectorize** (via Constellation service)
   - raw file in **R2** (when applicable)

### 4.1. Note Schema

```typescript
interface Note {
  id: string;
  userId: string;
  title: string;
  content: string;
  contentType: 'text' | 'markdown' | 'html';
  tags: string[];
  created: number; // timestamp
  updated: number; // timestamp
  fileKey?: string; // R2 key if applicable
}
```

### 4.2. Storage Mapping

| Storage Type | Technology                                       | Contents                                         |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| **Vector**     | **Cloudflare Vectorize** via Constellation service | Embeddings + metadata (`note_id`, `user_id`, timestamp) |
| **Structured** | **D1** SQLite DB `dome_meta`                            | Tables: `notes`, `tasks`, `reminders`, `tags`           |
| **Blob**       | **R2** Bucket `dome_raw`                                | Raw files (PDFs, images, etc.)                          |

## 5. Vector Database (Vectorize via Constellation)

- **Write**: Enqueue embedding jobs to Constellation service during ingest.
- **Query**: Use Constellation service RPC for vector searches in `/search` & `/chat`.
- P99 latency ≈ 2-3 ms, capacity scales with Constellation service configuration.

## 6. Search Flow

When a user performs a search:

1. Query is sent to the Dome API service.
2. Dome API calls Constellation service to perform the vector search.
3. Constellation embeds the query and searches the Vectorize index.
4. Results are returned to the Dome API service.
5. Dome API fetches note bodies from D1.
6. Complete results are returned to the user.

## 7. Ingestion Flow

When a user creates or updates a note:

1. Note metadata and content are stored in D1.
2. If the note includes a file, it's stored in R2.
3. An embedding job is enqueued for asynchronous processing by Constellation.
4. Constellation processes the job, generates the embedding, and stores it in Vectorize.

## 8. Authentication & Authorization

- JWT-based authentication
- Role-based access control
- Scoped API tokens
- OAuth2 for third-party integrations

## 9. Performance Requirements

- Search latency: < 200ms P95
- Ingestion throughput: 100 notes/second peak
- Availability: 99.9% uptime
- Global distribution: < 100ms latency from major regions

## 10. System Architecture

```
┌─────────────────┐
│  Client Apps    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Dome API      │
│   (Worker)      │
└────────┬────────┘
         │
    ┌────┴─────┐
    ▼          ▼
┌─────────┐  ┌─────────────┐
│   D1    │  │Constellation│
│ Database│  │  Service    │
└─────────┘  └──────┬──────┘
                    │
              ┌─────┴─────┐
              ▼           ▼
        ┌──────────┐  ┌─────────┐
        │Workers AI│  │Vectorize│
        └──────────┘  └─────────┘
```

## 11. Deployment

1. `wrangler d1 create dome_meta`
2. `wrangler vectorize create dome_notes --dims 384 --metric cosine`
3. Deploy Constellation service
4. `wrangler deploy` for each worker (`api`, `cron`, `notify`).

## 12. Monitoring & Observability

- Cloudflare Workers Analytics
- Custom metrics for search latency, embedding time, etc.
- Error tracking and alerting
- Usage dashboards

## 13. Cost Estimates

Based on 10,000 active users with 1,000 notes each:

- Workers: ~$50/month
- D1: ~$20/month
- Vectorize: ~$30/month
- R2: ~$5/month
- Workers AI: ~$25/month

Total: ~$130/month

## 14. Conclusion

The product now leverages **Cloudflare Workers, Constellation service, Vectorize, D1, R2, Queues, and Workers AI** to deliver a fully serverless, globally low-latency personal memory assistant—no containers or databases to run, and instant scaling as your user base grows.

The integration with the Constellation service provides a more robust, scalable approach to embedding and vector search operations, with improved error handling, monitoring, and performance.
