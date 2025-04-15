# Telegram Proxy Service: Detailed Design

This document provides a detailed design for the Telegram Proxy Service, focusing on communication protocols, deployment strategy, and scalability considerations for handling aggressive polling by the ingestor service.

## Table of Contents
1. [Communication Architecture](#communication-architecture)
2. [Deployment Strategy](#deployment-strategy)
3. [Scalability and Performance](#scalability-and-performance)
4. [Security Considerations](#security-considerations)
5. [Implementation Roadmap](#implementation-roadmap)

## Communication Architecture

### API Contract

The communication between the Cloudflare Worker and the Telegram Proxy Service will use a RESTful API with the following endpoints:

```
/api/v1/
├── /auth/
│   ├── /send-code
│   │   POST: Initiates authentication flow
│   ├── /verify-code
│   │   POST: Completes authentication and creates session
│   └── /refresh
│       POST: Refreshes an existing session
├── /sessions/
│   ├── /
│   │   GET: Lists all sessions
│   │   POST: Creates a new session manually
│   ├── /{sessionId}
│   │   GET: Gets session details
│   │   DELETE: Terminates a session
│   └── /status/{sessionId}
│       GET: Checks session health
├── /messages/
│   ├── /poll/{chatId}
│   │   GET: Polls for new messages (with cursor-based pagination)
│   ├── /history/{chatId}
│   │   GET: Gets message history (with parameters for filtering)
│   └── /send/{chatId}
│       POST: Sends a message
└── /system/
    ├── /health
    │   GET: Service health check
    ├── /metrics
    │   GET: Performance metrics
    └── /config
        GET: Current configuration (admin only)
```

### Request/Response Format

All API requests and responses will use JSON format:

**Example Request:**
```json
{
  "sessionId": "user123_session456",
  "params": {
    "limit": 100,
    "cursor": "message_id_123"
  },
  "options": {
    "includeMedia": true
  }
}
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "messages": [...],
    "nextCursor": "message_id_456"
  },
  "meta": {
    "count": 100,
    "hasMore": true,
    "executionTime": 120
  }
}
```

### Authentication and Security

1. **Service-to-Service Authentication:**
   - JWT-based authentication with short-lived tokens (15 minutes)
   - Mutual TLS for additional security in production
   - API keys for initial authentication

2. **Request Signing:**
   - All requests will include a signature header
   - HMAC-SHA256 signature of request body + timestamp
   - Prevents tampering and replay attacks

3. **Rate Limiting:**
   - Per-endpoint rate limits
   - Per-client rate limits
   - Graduated response (warning, throttling, blocking)

### Error Handling and Resilience

1. **Standardized Error Responses:**
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests",
    "details": {
      "retryAfter": 30,
      "limit": 100,
      "current": 120
    }
  }
}
```

2. **Circuit Breaker Pattern:**
   - Prevents cascading failures
   - Automatically disables problematic endpoints
   - Gradual recovery with exponential backoff

3. **Retry Strategy:**
   - Automatic retries for idempotent operations
   - Exponential backoff with jitter
   - Maximum retry attempts configurable per endpoint

### Real-time Updates

For more efficient operation than polling, the service will support WebSocket connections for real-time updates:

```
/api/v1/realtime/
├── /messages/{sessionId}
│   Streams new messages in real-time
└── /status/{sessionId}
    Streams session status updates
```

WebSocket messages will follow a standard format:
```json
{
  "type": "NEW_MESSAGE",
  "data": {
    "messageId": "123",
    "chatId": "456",
    "content": "Hello world"
  },
  "timestamp": 1650000000000
}
```

## Deployment Strategy

### Infrastructure Options

#### Recommended Setup: Kubernetes on DigitalOcean

1. **Kubernetes Cluster:**
   - 3-node cluster minimum (1 control plane, 2 workers)
   - Autoscaling enabled for worker nodes
   - Managed Kubernetes service for simplified operations

2. **Redis:**
   - Redis cluster with 3 masters, 3 replicas
   - Persistence enabled with both RDB and AOF
   - DigitalOcean Managed Database or Redis Enterprise

3. **Monitoring:**
   - Prometheus for metrics collection
   - Grafana for visualization
   - Loki for log aggregation
   - Alertmanager for alerts

4. **Networking:**
   - Cloudflare Spectrum for DDoS protection
   - Internal service mesh for secure service-to-service communication
   - Network policies for isolation

#### Alternative: AWS-based Deployment

1. **ECS with Fargate:**
   - Serverless container execution
   - Auto-scaling based on CPU/memory metrics
   - Application Load Balancer for traffic distribution

2. **ElastiCache for Redis:**
   - Multi-AZ deployment
   - Automatic failover
   - Encryption at rest and in transit

3. **CloudWatch:**
   - Metrics, logs, and alarms
   - Custom dashboards
   - Integration with SNS for notifications

### CI/CD Pipeline

1. **GitHub Actions Workflow:**
```yaml
name: Telegram Proxy CI/CD

on:
  push:
    branches: [ main, staging ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Set up Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      - name: Install dependencies
        run: npm ci
      - name: Run tests
        run: npm test
      - name: Run linting
        run: npm run lint

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Build Docker image
        run: docker build -t telegram-proxy:${{ github.sha }} .
      - name: Push to registry
        uses: docker/build-push-action@v2
        with:
          push: true
          tags: |
            registry.example.com/telegram-proxy:${{ github.sha }}
            registry.example.com/telegram-proxy:latest

  deploy:
    needs: build
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/staging'
    runs-on: ubuntu-latest
    steps:
      - name: Set Kubernetes context
        uses: azure/k8s-set-context@v1
        with:
          kubeconfig: ${{ secrets.KUBE_CONFIG }}
      - name: Deploy to Kubernetes
        run: |
          envsubst < k8s/deployment.yaml | kubectl apply -f -
          kubectl rollout status deployment/telegram-proxy
```

2. **Deployment Environments:**
   - Development: Local or ephemeral environments
   - Staging: Production-like environment for testing
   - Production: Highly available, scaled deployment

3. **Canary Deployments:**
   - Deploy to subset of nodes first
   - Gradually increase traffic
   - Automatic rollback on error thresholds

### Configuration Management

1. **Environment Variables:**
   - Non-sensitive configuration
   - Environment-specific settings

2. **Kubernetes Secrets:**
   - API credentials
   - Encryption keys
   - Database passwords

3. **ConfigMaps:**
   - Service discovery information
   - Tuning parameters
   - Feature flags

### Backup and Disaster Recovery

1. **Regular Backups:**
   - Redis snapshots every hour
   - Database backups daily
   - Configuration backups on change

2. **Disaster Recovery Plan:**
   - Multi-region deployment capability
   - Regular DR drills
   - Documented recovery procedures
   - Recovery time objective (RTO): 1 hour
   - Recovery point objective (RPO): 5 minutes

## Scalability and Performance

### Handling Aggressive Polling

The ingestor service will need to poll messages frequently across multiple chats and users. Here's how the architecture addresses this:

#### Connection Pooling

1. **Telegram Client Pool:**
   - Pre-initialized pool of Telegram clients
   - Clients are reused across requests
   - Pool size dynamically adjusted based on load
   - Health monitoring and automatic replacement of problematic clients

```javascript
// Simplified client pool implementation
class TelegramClientPool {
  constructor(options) {
    this.minSize = options.minSize || 5;
    this.maxSize = options.maxSize || 50;
    this.clients = new Map();
    this.available = [];
    this.initialize();
  }

  async initialize() {
    for (let i = 0; i < this.minSize; i++) {
      const client = await this.createClient();
      this.available.push(client.id);
      this.clients.set(client.id, client);
    }
  }

  async acquire(sessionData) {
    if (this.available.length === 0 && this.clients.size < this.maxSize) {
      const client = await this.createClient();
      this.clients.set(client.id, client);
      this.available.push(client.id);
    }

    if (this.available.length === 0) {
      throw new Error('No clients available');
    }

    const clientId = this.available.shift();
    const client = this.clients.get(clientId);
    await client.useSession(sessionData);
    return client;
  }

  release(clientId) {
    if (this.clients.has(clientId)) {
      this.available.push(clientId);
    }
  }
}
```

2. **Session Management:**
   - Sessions stored in Redis with TTL
   - Session data cached in memory for frequent access
   - Lazy loading of sessions
   - Automatic session refresh

#### Efficient Polling

1. **Cursor-based Pagination:**
   - Efficient retrieval of new messages
   - Prevents duplicate processing
   - Handles large message volumes

2. **Batch Processing:**
   - Retrieve multiple messages in a single request
   - Process messages in batches
   - Optimize network utilization

3. **Differential Updates:**
   - Only retrieve changes since last poll
   - Use Telegram's update mechanism when possible
   - Minimize data transfer

#### Caching Strategy

1. **Multi-level Caching:**
   - L1: In-memory cache (node-local)
   - L2: Redis cache (distributed)
   - Tiered expiration policies

2. **Cache Invalidation:**
   - Time-based expiration for volatile data
   - Event-based invalidation for immediate updates
   - Versioned cache keys

3. **Proactive Caching:**
   - Preemptively cache frequently accessed data
   - Background refresh of near-expiry items
   - Cache warming on startup

### Handling Telegram API Limits

1. **Rate Limiting:**
   - Respect Telegram's API limits (configurable)
   - Per-method rate limits
   - Per-user rate limits
   - Global rate limits

2. **Backoff Strategy:**
   - Exponential backoff on rate limit errors
   - Jitter to prevent thundering herd
   - Circuit breaker for persistent issues

3. **Request Prioritization:**
   - Critical operations get priority
   - Background operations yield to interactive ones
   - Fair scheduling across users

### Horizontal Scaling

1. **Stateless Design:**
   - No node-specific state (except caches)
   - Any request can be handled by any node
   - Seamless node addition/removal

2. **Load Balancing:**
   - Round-robin for even distribution
   - Least connections for optimal utilization
   - Session affinity for efficiency (but not required)

3. **Auto-scaling:**
   - Scale based on CPU/memory metrics
   - Scale based on request queue length
   - Predictive scaling based on time patterns

### Performance Benchmarks

Based on similar architectures, we can expect:

1. **Throughput:**
   - 100-200 requests/second per node
   - 5,000+ concurrent sessions per node
   - Linear scaling with additional nodes

2. **Latency:**
   - API requests: 50-200ms (p95)
   - Message polling: 100-300ms (p95)
   - Session operations: 30-100ms (p95)

3. **Resource Usage:**
   - 1-2 GB RAM per node (base)
   - +10 MB per 100 active sessions
   - 1-2 CPU cores per node (base)

## Security Considerations

### Data Protection

1. **Encryption:**
   - TLS 1.3 for all external communications
   - AES-256-GCM for session data at rest
   - Key rotation every 30 days

2. **Data Minimization:**
   - Only store essential session data
   - Automatic purging of expired sessions
   - No storage of message content unless required

3. **Access Control:**
   - Role-based access control
   - Principle of least privilege
   - Audit logging for all access

### Attack Mitigation

1. **DDoS Protection:**
   - Rate limiting at the edge
   - Traffic filtering
   - Automatic blocking of suspicious IPs

2. **Intrusion Detection:**
   - Anomaly detection
   - Suspicious pattern recognition
   - Real-time alerts

3. **Vulnerability Management:**
   - Regular security scans
   - Dependency auditing
   - Prompt patching

## Implementation Roadmap

### Phase 1: Core Infrastructure (2 weeks)

1. Set up Kubernetes cluster
2. Deploy Redis
3. Implement basic monitoring
4. Set up CI/CD pipeline

### Phase 2: Core Functionality (3 weeks)

1. Implement Telegram client pool
2. Develop session management
3. Create basic API endpoints
4. Implement authentication

### Phase 3: Scaling and Optimization (2 weeks)

1. Implement caching strategies
2. Add rate limiting and backoff
3. Optimize for performance
4. Add metrics and monitoring

### Phase 4: Security and Hardening (1 week)

1. Security review and hardening
2. Penetration testing
3. Documentation
4. Disaster recovery testing

### Phase 5: Integration and Testing (2 weeks)

1. Integrate with Cloudflare Worker
2. End-to-end testing
3. Performance testing
4. User acceptance testing