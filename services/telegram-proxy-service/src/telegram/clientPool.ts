// Using the telegram package instead of gramjs
import { TelegramClient } from 'telegram';
import { TelegramClientWrapper } from './clientWrapper';
import { CLIENT_POOL } from '../config';
import { logger } from '../utils/logger';
import type { SessionData } from '../storage/sessionStore';
import { TelegramError } from '../utils/errors';
import { generateRandomId } from '../utils/security';

/**
 * Interface for client pool statistics
 */
export interface ClientPoolStats {
  totalClients: number;
  availableClients: number;
  inUseClients: number;
  waitingRequests: number;
  minSize: number;
  maxSize: number;
  idleTimeoutMs: number;
  acquireTimeoutMs: number;
}

/**
 * Interface for client info in the pool
 */
interface ClientInfo {
  client: TelegramClientWrapper;
  inUse: boolean;
  sessionId?: string;
  lastUsed: number;
  createdAt: number;
}

/**
 * Interface for client request in the queue
 */
interface ClientRequest {
  resolve: (client: TelegramClientWrapper) => void;
  reject: (error: Error) => void;
  sessionId?: string;
  priority: number;
  timestamp: number;
}

/**
 * Telegram Client Pool
 * Manages a pool of TelegramClientWrapper instances for efficient resource usage
 */
export class TelegramClientPool {
  private clients: Map<string, ClientInfo> = new Map();
  private requestQueue: ClientRequest[] = [];
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  // Configuration
  private minSize: number;
  private maxSize: number;
  private acquireTimeoutMs: number;
  private idleTimeoutMs: number;

  // Statistics
  private totalAcquires = 0;
  private totalReleases = 0;
  private acquireErrors = 0;
  private totalCreated = 0;
  private totalDestroyed = 0;

  /**
   * Create a new TelegramClientPool
   */
  constructor(
    minSize = CLIENT_POOL.MIN_SIZE,
    maxSize = CLIENT_POOL.MAX_SIZE,
    acquireTimeoutMs = CLIENT_POOL.ACQUIRE_TIMEOUT_MS,
    idleTimeoutMs = CLIENT_POOL.IDLE_TIMEOUT_MS,
  ) {
    this.minSize = minSize;
    this.maxSize = maxSize;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;

    logger.info(`Created Telegram client pool (min: ${minSize}, max: ${maxSize})`);
  }

  /**
   * Initialize the client pool
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      logger.info('Initializing Telegram client pool');

      // Create initial clients
      const initialCreationPromises = [];
      for (let i = 0; i < this.minSize; i++) {
        initialCreationPromises.push(this.createClient());
      }

      await Promise.all(initialCreationPromises);

      // Start maintenance interval
      this.maintenanceInterval = setInterval(() => {
        this.performMaintenance().catch(error => {
          logger.error('Error during client pool maintenance:', error);
        });
      }, 60000); // Run maintenance every minute

      this.initialized = true;
      logger.info(`Telegram client pool initialized with ${this.clients.size} clients`);
    } catch (error) {
      logger.error('Failed to initialize client pool:', error);
      throw new TelegramError(
        `Failed to initialize client pool: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  /**
   * Acquire a client from the pool
   * @param session Optional session to use with the client
   * @param priority Priority of the request (higher values get served first)
   * @param timeoutMs Timeout for acquiring a client
   */
  async acquireClient(
    session?: SessionData,
    priority = 0,
    timeoutMs = this.acquireTimeoutMs,
  ): Promise<TelegramClientWrapper> {
    if (!this.initialized) {
      await this.initialize();
    }

    this.totalAcquires++;

    try {
      // First, try to find an available client
      const availableClient = this.findAvailableClient(session?.id);

      if (availableClient) {
        return this.prepareClientForUse(availableClient, session);
      }

      // If we can create a new client (haven't reached max size), do so
      if (this.clients.size < this.maxSize) {
        const newClient = await this.createClient();
        return this.prepareClientForUse(newClient, session);
      }

      // Otherwise, we need to wait for a client to become available
      logger.info(
        `No clients available, queueing request${session ? ` for session ${session.id}` : ''}`,
      );

      return new Promise<TelegramClientWrapper>((resolve, reject) => {
        const request: ClientRequest = {
          resolve,
          reject,
          sessionId: session?.id,
          priority,
          timestamp: Date.now(),
        };

        // Add to queue based on priority
        this.addToRequestQueue(request);

        // Set timeout
        setTimeout(() => {
          // Remove from queue if still there
          const index = this.requestQueue.indexOf(request);
          if (index !== -1) {
            this.requestQueue.splice(index, 1);
            this.acquireErrors++;
            reject(new TelegramError('Timeout while waiting for available client'));
          }
        }, timeoutMs);
      });
    } catch (error) {
      this.acquireErrors++;
      logger.error('Error acquiring client:', error);
      throw new TelegramError(
        `Failed to acquire client: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Release a client back to the pool
   * @param clientId ID of the client to release
   */
  async releaseClient(clientId: string): Promise<void> {
    const clientInfo = this.clients.get(clientId);

    if (!clientInfo) {
      logger.warn(`Attempted to release unknown client: ${clientId}`);
      return;
    }

    this.totalReleases++;

    try {
      // Mark as available
      clientInfo.inUse = false;
      clientInfo.sessionId = undefined;
      clientInfo.lastUsed = Date.now();

      logger.debug(`Released client ${clientId} back to pool`);

      // Process any waiting requests
      this.processNextRequest();
    } catch (error) {
      logger.error(`Error releasing client ${clientId}:`, error);
    }
  }

  /**
   * Create a new client and add it to the pool
   */
  async createClient(): Promise<TelegramClientWrapper> {
    const clientId = generateRandomId();
    const client = new TelegramClientWrapper(clientId);

    try {
      // Connect the client
      await client.connect();

      // Add to pool
      this.clients.set(clientId, {
        client,
        inUse: false,
        lastUsed: Date.now(),
        createdAt: Date.now(),
      });

      this.totalCreated++;
      logger.info(`Created new client ${clientId}, pool size: ${this.clients.size}`);

      return client;
    } catch (error) {
      logger.error(`Failed to create client ${clientId}:`, error);
      throw new TelegramError(
        `Failed to create client: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Perform maintenance on the client pool
   * - Remove idle clients that exceed the idle timeout
   * - Ensure the pool maintains at least the minimum number of clients
   * - Handle client failures and replace them as needed
   */
  async performMaintenance(): Promise<void> {
    logger.debug('Performing client pool maintenance');

    const now = Date.now();
    const clientsToRemove: string[] = [];
    let availableCount = 0;

    // Check each client
    for (const [clientId, info] of this.clients.entries()) {
      // Count available clients
      if (!info.inUse) {
        availableCount++;

        // Check if client has been idle too long and we're above min size
        const idleTime = now - info.lastUsed;
        if (idleTime > this.idleTimeoutMs && this.clients.size > this.minSize) {
          clientsToRemove.push(clientId);
        }
      }

      // TODO: Add health check for clients if needed
    }

    // Remove idle clients
    for (const clientId of clientsToRemove) {
      await this.removeClient(clientId);
    }

    // Ensure we have minimum number of clients
    const neededClients = this.minSize - this.clients.size;
    if (neededClients > 0) {
      logger.info(`Creating ${neededClients} clients to maintain minimum pool size`);

      const creationPromises = [];
      for (let i = 0; i < neededClients; i++) {
        creationPromises.push(
          this.createClient().catch(error => {
            logger.error('Failed to create client during maintenance:', error);
          }),
        );
      }

      await Promise.allSettled(creationPromises);
    }

    // Log pool status
    logger.info(
      `Pool status: ${this.clients.size} total, ${availableCount} available, ${this.requestQueue.length} waiting`,
    );
  }

  /**
   * Shutdown the client pool
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Telegram client pool');

    // Stop maintenance interval
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }

    // Disconnect all clients
    const disconnectPromises = [];
    for (const [clientId, info] of this.clients.entries()) {
      disconnectPromises.push(
        info.client.disconnect().catch(error => {
          logger.error(`Error disconnecting client ${clientId}:`, error);
        }),
      );
    }

    await Promise.allSettled(disconnectPromises);

    // Clear collections
    this.clients.clear();

    // Reject any waiting requests
    for (const request of this.requestQueue) {
      request.reject(new TelegramError('Client pool is shutting down'));
    }
    this.requestQueue = [];

    this.initialized = false;
    logger.info('Telegram client pool shut down');
  }

  /**
   * Get statistics about the client pool
   */
  getStats(): ClientPoolStats {
    const inUseCount = Array.from(this.clients.values()).filter(info => info.inUse).length;

    return {
      totalClients: this.clients.size,
      availableClients: this.clients.size - inUseCount,
      inUseClients: inUseCount,
      waitingRequests: this.requestQueue.length,
      minSize: this.minSize,
      maxSize: this.maxSize,
      idleTimeoutMs: this.idleTimeoutMs,
      acquireTimeoutMs: this.acquireTimeoutMs,
    };
  }

  /**
   * Get detailed metrics about the client pool
   */
  getDetailedMetrics() {
    const stats = this.getStats();

    return {
      ...stats,
      totalAcquires: this.totalAcquires,
      totalReleases: this.totalReleases,
      acquireErrors: this.acquireErrors,
      totalCreated: this.totalCreated,
      totalDestroyed: this.totalDestroyed,
      utilizationRate: stats.inUseClients / Math.max(stats.totalClients, 1),
      oldestClientAge: this.getOldestClientAge(),
      averageClientAge: this.getAverageClientAge(),
    };
  }

  /**
   * Find an available client in the pool
   * @param sessionId Optional session ID to match
   */
  private findAvailableClient(sessionId?: string): TelegramClientWrapper | null {
    // First try to find a client already using this session
    if (sessionId) {
      for (const [_, info] of this.clients.entries()) {
        if (!info.inUse && info.sessionId === sessionId) {
          return info.client;
        }
      }
    }

    // Otherwise, find any available client
    for (const [_, info] of this.clients.entries()) {
      if (!info.inUse) {
        return info.client;
      }
    }

    return null;
  }

  /**
   * Prepare a client for use
   * @param client The client to prepare
   * @param session Optional session to use
   */
  private async prepareClientForUse(
    client: TelegramClientWrapper,
    session?: SessionData,
  ): Promise<TelegramClientWrapper> {
    const clientId = client.getId();
    const clientInfo = this.clients.get(clientId);

    if (!clientInfo) {
      throw new TelegramError(`Client ${clientId} not found in pool`);
    }

    // Mark as in use
    clientInfo.inUse = true;

    // Apply session if provided
    if (session) {
      clientInfo.sessionId = session.id;
      await client.useSession(session);
    }

    logger.debug(`Acquired client ${clientId}${session ? ` with session ${session.id}` : ''}`);

    return client;
  }

  /**
   * Add a request to the queue based on priority
   */
  private addToRequestQueue(request: ClientRequest): void {
    // Insert based on priority (higher priority first)
    let insertIndex = this.requestQueue.length;

    for (let i = 0; i < this.requestQueue.length; i++) {
      if (request.priority > this.requestQueue[i].priority) {
        insertIndex = i;
        break;
      }
    }

    this.requestQueue.splice(insertIndex, 0, request);
  }

  /**
   * Get the total number of clients in the pool
   */
  getTotalCount(): number {
    return this.clients.size;
  }

  /**
   * Get the number of available clients in the pool
   */
  getAvailableCount(): number {
    return Array.from(this.clients.values()).filter(info => !info.inUse).length;
  }

  /**
   * Process the next request in the queue
   */
  private async processNextRequest(): Promise<void> {
    if (this.requestQueue.length === 0) {
      return;
    }

    // Find an available client
    const availableClient = this.findAvailableClient();

    if (!availableClient) {
      return;
    }

    // Get the next request
    const request = this.requestQueue.shift();

    if (!request) {
      return;
    }

    try {
      // If request has a session ID, get the session
      let session: SessionData | undefined;

      if (request.sessionId) {
        // This would normally get the session from the session store
        // But for simplicity, we'll just create a minimal session object
        session = {
          id: request.sessionId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          isActive: true,
        };
      }

      // Prepare the client
      const client = await this.prepareClientForUse(availableClient, session);

      // Resolve the request
      request.resolve(client);
    } catch (error) {
      logger.error('Error processing queued request:', error);
      request.reject(
        new TelegramError(
          `Failed to process queued request: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        ),
      );

      // Release the client back to the pool
      await this.releaseClient(availableClient.getId());

      // Try to process the next request
      this.processNextRequest();
    }
  }

  /**
   * Remove a client from the pool
   */
  private async removeClient(clientId: string): Promise<void> {
    const clientInfo = this.clients.get(clientId);

    if (!clientInfo) {
      return;
    }

    try {
      // Disconnect the client
      await clientInfo.client.disconnect();

      // Remove from pool
      this.clients.delete(clientId);

      this.totalDestroyed++;
      logger.info(`Removed client ${clientId} from pool, new size: ${this.clients.size}`);
    } catch (error) {
      logger.error(`Error removing client ${clientId}:`, error);
    }
  }

  /**
   * Get the age of the oldest client in milliseconds
   */
  private getOldestClientAge(): number {
    let oldestTime = Date.now();

    for (const [_, info] of this.clients.entries()) {
      if (info.createdAt < oldestTime) {
        oldestTime = info.createdAt;
      }
    }

    return Date.now() - oldestTime;
  }

  /**
   * Get the average age of clients in milliseconds
   */
  private getAverageClientAge(): number {
    if (this.clients.size === 0) {
      return 0;
    }

    let totalAge = 0;
    const now = Date.now();

    for (const [_, info] of this.clients.entries()) {
      totalAge += now - info.createdAt;
    }

    return totalAge / this.clients.size;
  }

  /**
   * Alias for acquireClient
   */
  async acquire(session?: SessionData, priority = 0): Promise<TelegramClientWrapper> {
    return this.acquireClient(session, priority);
  }

  /**
   * Alias for releaseClient
   */
  async release(clientId: string): Promise<void> {
    return this.releaseClient(clientId);
  }
}

// Export singleton instance
export const clientPool = new TelegramClientPool();
