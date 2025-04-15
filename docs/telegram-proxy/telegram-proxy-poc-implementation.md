# Telegram Proxy Service: Proof of Concept Implementation

This document provides a proof-of-concept implementation for the Telegram Proxy Service, focusing on the key components: client pool, session management, and API server.

## Project Structure

```
telegram-proxy-service/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # Entry point
│   ├── config.ts                # Configuration
│   ├── api/
│   │   ├── server.ts            # Express server setup
│   │   ├── routes.ts            # API routes
│   │   ├── middleware/
│   │   │   ├── auth.ts          # Authentication middleware
│   │   │   ├── rateLimit.ts     # Rate limiting
│   │   │   └── errorHandler.ts  # Error handling
│   │   └── controllers/
│   │       ├── auth.ts          # Authentication endpoints
│   │       ├── sessions.ts      # Session management
│   │       └── messages.ts      # Message operations
│   ├── telegram/
│   │   ├── clientPool.ts        # Telegram client pool
│   │   ├── clientWrapper.ts     # GramJS wrapper
│   │   └── sessionManager.ts    # Session management
│   ├── storage/
│   │   ├── redis.ts             # Redis client
│   │   └── sessionStore.ts      # Session storage
│   └── utils/
│       ├── logger.ts            # Logging utility
│       ├── errors.ts            # Error classes
│       └── security.ts          # Security utilities
└── tests/
    ├── unit/                    # Unit tests
    └── integration/             # Integration tests
```

## Core Implementation Files

### 1. Package Configuration

**package.json**
```json
{
  "name": "telegram-proxy-service",
  "version": "0.1.0",
  "description": "Proxy service for Telegram MTProto API",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node-dev --respawn src/index.ts",
    "test": "jest",
    "lint": "eslint src/**/*.ts"
  },
  "dependencies": {
    "express": "^4.18.2",
    "telegram": "^2.26.0",
    "redis": "^4.6.10",
    "ioredis": "^5.3.2",
    "winston": "^3.11.0",
    "dotenv": "^16.3.1",
    "jsonwebtoken": "^9.0.2",
    "helmet": "^7.1.0",
    "cors": "^2.8.5",
    "express-rate-limit": "^7.1.5",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "typescript": "^5.2.2",
    "ts-node-dev": "^2.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.1",
    "eslint": "^8.53.0",
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.8",
    "@types/node": "^20.9.0"
  }
}
```

**tsconfig.json**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### 2. Configuration

**src/config.ts**
```typescript
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface Config {
  port: number;
  environment: string;
  telegram: {
    apiId: number;
    apiHash: string;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  security: {
    jwtSecret: string;
    jwtExpiresIn: string;
  };
  clientPool: {
    minSize: number;
    maxSize: number;
    idleTimeoutMs: number;
  };
  rateLimits: {
    windowMs: number;
    maxRequests: number;
  };
}

const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
  environment: process.env.NODE_ENV || 'development',
  telegram: {
    apiId: parseInt(process.env.TELEGRAM_API_ID || '0', 10),
    apiHash: process.env.TELEGRAM_API_HASH || '',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  security: {
    jwtSecret: process.env.JWT_SECRET || 'your-secret-key',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '15m',
  },
  clientPool: {
    minSize: parseInt(process.env.CLIENT_POOL_MIN_SIZE || '5', 10),
    maxSize: parseInt(process.env.CLIENT_POOL_MAX_SIZE || '20', 10),
    idleTimeoutMs: parseInt(process.env.CLIENT_IDLE_TIMEOUT_MS || '300000', 10), // 5 minutes
  },
  rateLimits: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10), // 1 minute
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },
};

// Validate critical configuration
if (config.telegram.apiId === 0 || !config.telegram.apiHash) {
  throw new Error('Telegram API credentials are required');
}

if (!config.security.jwtSecret || config.security.jwtSecret === 'your-secret-key') {
  console.warn('WARNING: Using default JWT secret. This is insecure for production.');
}

export default config;
```

### 3. Telegram Client Pool

**src/telegram/clientPool.ts**
```typescript
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import logger from '../utils/logger';

interface ClientInfo {
  client: TelegramClient;
  busy: boolean;
  lastUsed: number;
  sessionInUse?: string;
}

export class TelegramClientPool {
  private clients: Map<string, ClientInfo> = new Map();
  private apiId: number;
  private apiHash: string;
  private minSize: number;
  private maxSize: number;
  private idleTimeoutMs: number;
  private maintenanceInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.apiId = config.telegram.apiId;
    this.apiHash = config.telegram.apiHash;
    this.minSize = config.clientPool.minSize;
    this.maxSize = config.clientPool.maxSize;
    this.idleTimeoutMs = config.clientPool.idleTimeoutMs;
  }

  /**
   * Initialize the client pool
   */
  public async initialize(): Promise<void> {
    logger.info(`Initializing Telegram client pool with ${this.minSize} clients`);
    
    // Create initial set of clients
    const initPromises = [];
    for (let i = 0; i < this.minSize; i++) {
      initPromises.push(this.createClient());
    }
    
    await Promise.all(initPromises);
    
    // Start maintenance interval
    this.maintenanceInterval = setInterval(() => this.performMaintenance(), 60000); // Every minute
    
    logger.info('Telegram client pool initialized successfully');
  }

  /**
   * Create a new Telegram client
   */
  private async createClient(): Promise<string> {
    const clientId = uuidv4();
    
    // Create a new client with an empty session
    const client = new TelegramClient(
      new StringSession(''),
      this.apiId,
      this.apiHash,
      {
        connectionRetries: 3,
        useWSS: true,
        maxConcurrentDownloads: 10,
      }
    );
    
    this.clients.set(clientId, {
      client,
      busy: false,
      lastUsed: Date.now(),
    });
    
    logger.debug(`Created new Telegram client: ${clientId}`);
    return clientId;
  }

  /**
   * Acquire a client from the pool
   */
  public async acquireClient(sessionString?: string): Promise<{ clientId: string; client: TelegramClient }> {
    // Find an available client
    for (const [clientId, clientInfo] of this.clients.entries()) {
      if (!clientInfo.busy) {
        clientInfo.busy = true;
        clientInfo.lastUsed = Date.now();
        
        // If session string is provided, use it
        if (sessionString) {
          clientInfo.sessionInUse = sessionString;
          
          // Connect with the provided session
          const session = new StringSession(sessionString);
          clientInfo.client.session = session;
          
          // Connect if not already connected
          if (!clientInfo.client.connected) {
            await clientInfo.client.connect();
          }
        }
        
        logger.debug(`Acquired client: ${clientId}`);
        return { clientId, client: clientInfo.client };
      }
    }
    
    // If no available clients and we haven't reached max size, create a new one
    if (this.clients.size < this.maxSize) {
      const clientId = await this.createClient();
      const clientInfo = this.clients.get(clientId)!;
      clientInfo.busy = true;
      
      // If session string is provided, use it
      if (sessionString) {
        clientInfo.sessionInUse = sessionString;
        
        // Connect with the provided session
        const session = new StringSession(sessionString);
        clientInfo.client.session = session;
        await clientInfo.client.connect();
      }
      
      logger.debug(`Created and acquired new client: ${clientId}`);
      return { clientId, client: clientInfo.client };
    }
    
    // If we've reached max size and no clients are available, throw an error
    logger.error('No clients available and max pool size reached');
    throw new Error('No Telegram clients available');
  }

  /**
   * Release a client back to the pool
   */
  public async releaseClient(clientId: string): Promise<void> {
    const clientInfo = this.clients.get(clientId);
    
    if (!clientInfo) {
      logger.warn(`Attempted to release non-existent client: ${clientId}`);
      return;
    }
    
    // Reset session if one was in use
    if (clientInfo.sessionInUse) {
      // We don't disconnect, just mark as available for reuse
      clientInfo.sessionInUse = undefined;
    }
    
    clientInfo.busy = false;
    clientInfo.lastUsed = Date.now();
    
    logger.debug(`Released client: ${clientId}`);
  }

  /**
   * Perform maintenance on the client pool
   */
  private async performMaintenance(): Promise<void> {
    logger.debug('Performing client pool maintenance');
    
    const now = Date.now();
    const clientsToRemove: string[] = [];
    
    // Identify idle clients that exceed our minimum pool size
    for (const [clientId, clientInfo] of this.clients.entries()) {
      if (!clientInfo.busy && 
          now - clientInfo.lastUsed > this.idleTimeoutMs && 
          this.clients.size > this.minSize) {
        clientsToRemove.push(clientId);
      }
    }
    
    // Remove idle clients
    for (const clientId of clientsToRemove) {
      const clientInfo = this.clients.get(clientId);
      if (clientInfo) {
        try {
          if (clientInfo.client.connected) {
            await clientInfo.client.disconnect();
          }
          this.clients.delete(clientId);
          logger.debug(`Removed idle client: ${clientId}`);
        } catch (error) {
          logger.error(`Error disconnecting client ${clientId}:`, error);
        }
      }
    }
    
    // Ensure we have at least minSize clients
    const availableCount = Array.from(this.clients.values()).filter(c => !c.busy).length;
    if (availableCount < this.minSize / 2) {
      logger.info(`Low on available clients (${availableCount}), creating more`);
      
      // Create new clients up to minSize
      const numToCreate = Math.min(
        this.minSize - availableCount,
        this.maxSize - this.clients.size
      );
      
      const createPromises = [];
      for (let i = 0; i < numToCreate; i++) {
        createPromises.push(this.createClient());
      }
      
      await Promise.all(createPromises);
    }
  }

  /**
   * Shutdown the client pool
   */
  public async shutdown(): Promise<void> {
    logger.info('Shutting down Telegram client pool');
    
    // Clear maintenance interval
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }
    
    // Disconnect all clients
    const disconnectPromises = [];
    for (const [clientId, clientInfo] of this.clients.entries()) {
      disconnectPromises.push(
        clientInfo.client.disconnect()
          .catch(err => logger.error(`Error disconnecting client ${clientId}:`, err))
      );
    }
    
    await Promise.all(disconnectPromises);
    this.clients.clear();
    
    logger.info('Telegram client pool shutdown complete');
  }
}

// Export singleton instance
const clientPool = new TelegramClientPool();
export default clientPool;
```

### 4. Session Management

**src/telegram/sessionManager.ts**
```typescript
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { v4 as uuidv4 } from 'uuid';
import clientPool from './clientPool';
import sessionStore from '../storage/sessionStore';
import logger from '../utils/logger';
import { ApiError } from '../utils/errors';

interface SessionMetadata {
  userId: number;
  phoneNumber: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date;
}

export class SessionManager {
  /**
   * Start a new authentication session
   */
  public async startAuthSession(phoneNumber: string): Promise<{
    phoneCodeHash: string;
    isCodeViaApp: boolean;
    timeout: number;
  }> {
    logger.info(`Starting auth session for phone number: ${phoneNumber}`);
    
    // Acquire a client from the pool
    const { clientId, client } = await clientPool.acquireClient();
    
    try {
      // Connect to Telegram
      if (!client.connected) {
        await client.connect();
      }
      
      // Send the authentication code
      const result = await client.sendCode({
        apiId: client.apiId,
        apiHash: client.apiHash.toString(),
        phoneNumber,
      });
      
      logger.info(`Auth code sent to ${phoneNumber}`);
      
      return {
        phoneCodeHash: result.phoneCodeHash,
        isCodeViaApp: result.type?._ === 'auth.sentCodeTypeApp',
        timeout: result.timeout || 120,
      };
    } catch (error) {
      logger.error(`Error sending auth code to ${phoneNumber}:`, error);
      throw new ApiError('SEND_CODE_FAILED', 'Failed to send authentication code', 500);
    } finally {
      // Release the client back to the pool
      await clientPool.releaseClient(clientId);
    }
  }

  /**
   * Complete authentication and create a session
   */
  public async completeAuthentication(
    phoneNumber: string,
    phoneCodeHash: string,
    code: string
  ): Promise<{
    sessionId: string;
    userId: number;
    expiresAt: Date;
  }> {
    logger.info(`Completing authentication for phone number: ${phoneNumber}`);
    
    // Acquire a client from the pool
    const { clientId, client } = await clientPool.acquireClient();
    
    try {
      // Connect to Telegram
      if (!client.connected) {
        await client.connect();
      }
      
      // Sign in with the code
      await client.invoke({
        _: 'auth.signIn',
        phoneNumber,
        phoneCodeHash,
        phoneCode: code,
      });
      
      // Get user information
      const me = await client.getMe();
      
      // Get the session string
      const stringSession = client.session as StringSession;
      const sessionString = stringSession.save();
      
      // Generate a unique session ID
      const sessionId = uuidv4();
      
      // Calculate expiration date (30 days from now)
      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + 30);
      
      // Create session metadata
      const metadata: SessionMetadata = {
        userId: typeof me.id === 'number' ? me.id : parseInt(String(me.id), 10),
        phoneNumber,
        firstName: typeof me.firstName === 'string' ? me.firstName : undefined,
        lastName: typeof me.lastName === 'string' ? me.lastName : undefined,
        username: typeof me.username === 'string' ? me.username : undefined,
        createdAt: now,
        expiresAt,
        lastUsedAt: now,
      };
      
      // Store the session
      await sessionStore.saveSession(sessionId, sessionString, metadata);
      
      logger.info(`Authentication completed for user ${metadata.userId}`);
      
      return {
        sessionId,
        userId: metadata.userId,
        expiresAt,
      };
    } catch (error) {
      logger.error(`Error completing authentication for ${phoneNumber}:`, error);
      throw new ApiError('VERIFY_CODE_FAILED', 'Failed to verify authentication code', 500);
    } finally {
      // Release the client back to the pool
      await clientPool.releaseClient(clientId);
    }
  }

  /**
   * Get a session by ID
   */
  public async getSession(sessionId: string): Promise<{
    sessionString: string;
    metadata: SessionMetadata;
  }> {
    logger.debug(`Getting session: ${sessionId}`);
    
    // Get the session from the store
    const session = await sessionStore.getSession(sessionId);
    
    if (!session) {
      logger.warn(`Session not found: ${sessionId}`);
      throw new ApiError('SESSION_NOT_FOUND', 'Session not found or expired', 404);
    }
    
    // Check if the session is expired
    if (new Date() > session.metadata.expiresAt) {
      logger.warn(`Session expired: ${sessionId}`);
      await sessionStore.deleteSession(sessionId);
      throw new ApiError('SESSION_EXPIRED', 'Session expired', 401);
    }
    
    // Update last used timestamp
    session.metadata.lastUsedAt = new Date();
    await sessionStore.updateSessionMetadata(sessionId, session.metadata);
    
    return session;
  }

  /**
   * Execute a Telegram operation using a session
   */
  public async executeWithSession<T>(
    sessionId: string,
    operation: (client: TelegramClient) => Promise<T>
  ): Promise<T> {
    logger.debug(`Executing operation with session: ${sessionId}`);
    
    // Get the session
    const { sessionString } = await this.getSession(sessionId);
    
    // Acquire a client with this session
    const { clientId, client } = await clientPool.acquireClient(sessionString);
    
    try {
      // Execute the operation
      return await operation(client);
    } catch (error) {
      logger.error(`Error executing operation with session ${sessionId}:`, error);
      throw new ApiError('OPERATION_FAILED', 'Failed to execute Telegram operation', 500);
    } finally {
      // Release the client back to the pool
      await clientPool.releaseClient(clientId);
    }
  }

  /**
   * Revoke a session
   */
  public async revokeSession(sessionId: string): Promise<void> {
    logger.info(`Revoking session: ${sessionId}`);
    
    // Get the session
    const session = await sessionStore.getSession(sessionId);
    
    if (!session) {
      logger.warn(`Session not found for revocation: ${sessionId}`);
      return; // Session already gone, nothing to do
    }
    
    try {
      // Acquire a client with this session
      const { clientId, client } = await clientPool.acquireClient(session.sessionString);
      
      try {
        // Log out from Telegram
        if (client.connected) {
          await client.invoke({ _: 'auth.logOut' });
        }
      } catch (error) {
        logger.error(`Error logging out session ${sessionId}:`, error);
        // Continue with deletion even if logout fails
      } finally {
        // Release the client back to the pool
        await clientPool.releaseClient(clientId);
      }
    } catch (error) {
      logger.error(`Error acquiring client for session revocation ${sessionId}:`, error);
      // Continue with deletion even if client acquisition fails
    }
    
    // Delete the session from the store
    await sessionStore.deleteSession(sessionId);
    
    logger.info(`Session revoked: ${sessionId}`);
  }
}

// Export singleton instance
const sessionManager = new SessionManager();
export default sessionManager;
```

## Integration with Cloudflare Worker

To integrate this Telegram Proxy Service with the Cloudflare Worker, we would need to update the Worker to communicate with the proxy instead of directly with Telegram. Here's a simplified example of how the Worker would interact with the proxy:

```typescript
// In the Cloudflare Worker
async function sendAuthCode(phoneNumber: string) {
  const response = await fetch(`${TELEGRAM_PROXY_URL}/api/v1/auth/send-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ phoneNumber }),
  });
  
  const data = await response.json();
  
  if (!data.success) {
    throw new Error(data.error?.message || 'Failed to send authentication code');
  }
  
  return data.data;
}

async function verifyAuthCode(phoneNumber: string, phoneCodeHash: string, code: string) {
  const response = await fetch(`${TELEGRAM_PROXY_URL}/api/v1/auth/verify-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      phoneNumber,
      phoneCodeHash,
      code,
    }),
  });
  
  const data = await response.json();
  
  if (!data.success) {
    throw new Error(data.error?.message || 'Failed to verify authentication code');
  }
  
  return data.data;
}

// For the ingestor service to poll messages
async function pollMessages(sessionId: string, chatId: string, limit = 100, cursor?: string) {
  const url = new URL(`${TELEGRAM_PROXY_URL}/api/v1/messages/poll/${chatId}`);
  
  if (limit) url.searchParams.append('limit', limit.toString());
  if (cursor) url.searchParams.append('cursor', cursor);
  
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'X-Session-ID': sessionId,
    },
  });
  
  const data = await response.json();
  
  if (!data.success) {
    throw new Error(data.error?.message || 'Failed to poll messages');
  }
  
  return data.data;
}
```

## Deployment with Docker and Kubernetes

For deployment, we would use Docker to containerize the application and Kubernetes to orchestrate it. Here's a simplified Dockerfile and Kubernetes configuration:

**Dockerfile**
```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY dist/ ./dist/

# Expose the port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production

# Start the application
CMD ["node", "dist/index.js"]
```

**kubernetes/deployment.yaml**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: telegram-proxy
  labels:
    app: telegram-proxy
spec:
  replicas: 3
  selector:
    matchLabels:
      app: telegram-proxy
  template:
    metadata:
      labels:
        app: telegram-proxy
    spec:
      containers:
      - name: telegram-proxy
        image: telegram-proxy:latest
        ports:
        - containerPort: 3000
        env:
        - name: PORT
          value: "3000"
        - name: TELEGRAM_API_ID
          valueFrom:
            secretKeyRef:
              name: telegram-secrets
              key: api-id
        - name: TELEGRAM_API_HASH
          valueFrom:
            secretKeyRef:
              name: telegram-secrets
              key: api-hash
        - name: REDIS_HOST
          value: "redis-master"
        - name: REDIS_PORT
          value: "6379"
        - name: REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: redis-password
              key: password
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: jwt-secret
              key: secret
        resources:
          limits:
            cpu: "1"
            memory: "1Gi"
          requests:
            cpu: "500m"
            memory: "512Mi"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
```

**kubernetes/service.yaml**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: telegram-proxy
spec:
  selector:
    app: telegram-proxy
  ports:
  - port: 80
    targetPort: 3000
  type: ClusterIP
```

**kubernetes/ingress.yaml**
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: telegram-proxy
  annotations:
    kubernetes.io/ingress.class: "nginx"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
  - hosts:
    - telegram-proxy.example.com
    secretName: telegram-proxy-tls
  rules:
  - host: telegram-proxy.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: telegram-proxy
            port:
              number: 80
```

## Conclusion

This proof-of-concept implementation demonstrates the key components of the Telegram Proxy Service:

1. **Client Pool**: Efficiently manages Telegram client instances, reusing them across requests to minimize resource usage and connection overhead.

2. **Session Management**: Securely stores and retrieves session data, with proper encryption and expiration handling.

3. **API Server**: Provides a clean RESTful interface for the Cloudflare Worker to interact with.

4. **Deployment**: Containerized with Docker and orchestrated with Kubernetes for scalability and reliability.

This architecture addresses the limitations of running the Telegram client in Cloudflare Workers by offloading the WebSocket connections and event handling to a dedicated service that's designed to handle these requirements.
