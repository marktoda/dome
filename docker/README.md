# Docker Configuration for Dome2 RAG Platform

This directory contains Docker configurations for both development and
production environments.

## Quick Start

### Development Environment

```bash
# Start all services
make dev-up

# View logs
make dev-logs

# Stop services
make dev-down

# Clean up (removes volumes)
make dev-clean
```

### Production Environment

```bash
# Create .env.prod file with required variables
cp .env.example .env.prod
# Edit .env.prod with your production values

# Start services
make prod-up

# View logs
make prod-logs

# Stop services
make prod-down
```

## Services

### Core Services

1. **Kafka** (+ Zookeeper)

   - Message broker for event streaming
   - Development: `localhost:9092`
   - Includes Kafka UI at `http://localhost:8090`

2. **PostgreSQL**

   - Metadata storage and application data
   - Development: `localhost:5432`
   - Default credentials: `dome2/dome2_dev`

3. **Redis**
   - Caching and session storage
   - Development: `localhost:6379`
   - Production requires password via `REDIS_PASSWORD`

### Vector Databases

1. **Weaviate** (Primary)

   - Production-ready vector database
   - Development: `http://localhost:8080`
   - Supports hybrid search (vector + BM25)

2. **Chroma** (Development)
   - Lightweight vector database for local development
   - Development: `http://localhost:8000`

### Optional Services

1. **Ollama** (Profile: `ollama`)

   - Local LLM inference
   - Requires GPU support
   - Start with: `docker-compose --profile ollama up -d`

2. **pgAdmin** (Profile: `tools`)
   - PostgreSQL management UI
   - Development: `http://localhost:5050`
   - Start with: `docker-compose --profile tools up -d`

## Environment Variables

### Development

No environment variables required - uses defaults.

### Production

Required variables in `.env.prod`:

```bash
# PostgreSQL
POSTGRES_USER=dome2
POSTGRES_PASSWORD=<secure-password>
POSTGRES_DB=dome2

# Redis
REDIS_PASSWORD=<secure-password>

# Weaviate
WEAVIATE_API_KEY=<secure-api-key>

# Application
OPENAI_API_KEY=<your-openai-key>
# ... other API keys
```

## Volumes

All services use named volumes for data persistence:

- `zookeeper-data`, `zookeeper-logs` - Kafka metadata
- `kafka-data` - Kafka message logs
- `postgres-data` - PostgreSQL data
- `redis-data` - Redis persistence
- `weaviate-data` - Weaviate vector storage
- `chroma-data` - Chroma vector storage

## Networking

All services are connected via the `dome2-network` bridge network with subnet
`172.20.0.0/16`.

## Health Checks

All services include health checks for proper dependency management and
monitoring.

## Resource Limits

Production configuration includes resource limits:

- Kafka: 2GB memory
- Weaviate: 4GB memory
- PostgreSQL: 2GB memory
- Redis: 1GB memory
- API: 1GB memory per instance

## Kafka Topics

Create required topics after starting Kafka:

```bash
make kafka-topics
```

This creates:

- `github-events` (3 partitions)
- `notion-events` (3 partitions)
- `slack-events` (3 partitions)
- `linear-events` (3 partitions)
- `ingestion-dlq` (1 partition)

## Database Schema

PostgreSQL is initialized with the schema in `postgres/init.sql`, which
includes:

- Organizations management
- Document metadata storage
- Chunk storage
- API key management
- Audit logging

## Troubleshooting

### Services not starting

1. Check logs: `make dev-logs`
2. Ensure ports are not in use
3. Verify Docker daemon is running

### Out of memory

1. Increase Docker memory allocation
2. Reduce service resource limits
3. Use fewer services in development

### Permission issues

1. Ensure volume directories have correct permissions
2. Run `docker-compose down -v` to reset volumes

### Kafka connection issues

1. Wait for Kafka to fully start (check health)
2. Verify advertised listeners configuration
3. Check firewall/network settings
