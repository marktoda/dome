import type { RedisOptions, Cluster, ClusterOptions } from 'ioredis';
import Redis from 'ioredis';
import EventEmitter from 'events';
import { REDIS } from '../config';
import { logger } from '../utils/logger';
import { RedisError } from '../utils/errors';

/**
 * Redis connection status
 */
export enum RedisConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
  READY = 'ready',
}

/**
 * Redis client type
 */
export type RedisClient = Redis | Cluster;

/**
 * Redis connection options
 */
export interface RedisConnectionOptions {
  /** Redis host */
  host: string;
  /** Redis port */
  port: number;
  /** Redis password */
  password?: string;
  /** Redis database number */
  db?: number;
  /** Key prefix */
  keyPrefix?: string;
  /** Connection name */
  connectionName?: string;
  /** Enable TLS */
  tls?: boolean;
  /** Maximum number of clients in the pool */
  poolSize?: number;
  /** Minimum number of clients in the pool */
  minPoolSize?: number;
  /** Maximum number of reconnection attempts */
  maxReconnectAttempts?: number;
  /** Initial reconnection delay in ms */
  reconnectDelay?: number;
  /** Maximum reconnection delay in ms */
  maxReconnectDelay?: number;
  /** Command timeout in ms */
  commandTimeout?: number;
  /** Enable cluster mode */
  cluster?: boolean;
  /** Cluster nodes (only used if cluster is true) */
  clusterNodes?: { host: string; port: number }[];
}

/**
 * Redis pub/sub message
 */
export interface RedisPubSubMessage {
  /** Channel the message was published to */
  channel: string;
  /** Message payload */
  message: string;
  /** Pattern that matched the channel (for pattern subscriptions) */
  pattern?: string;
}

/**
 * Redis service for managing Redis connections and operations
 */
export class RedisService extends EventEmitter {
  private clients: Map<string, RedisClient> = new Map();
  private pubSubClient: RedisClient | null = null;
  private status: RedisConnectionStatus = RedisConnectionStatus.DISCONNECTED;
  private options: RedisConnectionOptions;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Explicitly declare emit method to fix TypeScript errors
  public emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
  private subscriptions: Map<string, Set<(message: RedisPubSubMessage) => void>> = new Map();
  private patternSubscriptions: Map<string, Set<(message: RedisPubSubMessage) => void>> = new Map();

  /**
   * Create a new RedisService instance
   * @param options Redis connection options
   */
  constructor(options?: Partial<RedisConnectionOptions>) {
    super();

    // Set default options
    this.options = {
      host: REDIS.HOST,
      port: REDIS.PORT,
      password: REDIS.PASSWORD || undefined,
      db: REDIS.DB,
      keyPrefix: REDIS.PREFIX,
      connectionName: 'telegram-proxy-service',
      tls: false,
      poolSize: 10,
      minPoolSize: 2,
      maxReconnectAttempts: 20,
      reconnectDelay: 100,
      maxReconnectDelay: 10000,
      commandTimeout: 5000,
      cluster: false,
      ...options,
    };
  }

  /**
   * Connect to Redis
   */
  public async connect(): Promise<void> {
    if (
      this.status === RedisConnectionStatus.CONNECTED ||
      this.status === RedisConnectionStatus.CONNECTING
    ) {
      return;
    }

    this.status = RedisConnectionStatus.CONNECTING;
    this.emit('status', this.status);

    try {
      // Initialize the connection pool
      await this.initializeConnectionPool();

      // Initialize the pub/sub client
      await this.initializePubSubClient();

      // Start health check interval
      this.startHealthCheck();

      this.status = RedisConnectionStatus.CONNECTED;
      this.emit('status', this.status);
      this.emit('connect');

      logger.info('Redis service connected');
    } catch (error) {
      this.status = RedisConnectionStatus.ERROR;
      this.emit('status', this.status);
      this.emit('error', error);

      logger.error('Redis connection failed:', error);

      // Attempt to reconnect
      this.scheduleReconnect();

      throw new RedisError(
        `Failed to connect to Redis: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Disconnect from Redis
   */
  public async disconnect(): Promise<void> {
    // Clear health check interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close all clients
    const closePromises: Promise<void>[] = [];

    for (const [id, client] of this.clients.entries()) {
      closePromises.push(
        client
          .quit()
          .then(() => {
            logger.debug(`Redis client ${id} disconnected`);
          })
          .catch((error: Error) => {
            logger.warn(`Error disconnecting Redis client ${id}:`, error);
          }),
      );
    }

    // Close pub/sub client
    if (this.pubSubClient) {
      closePromises.push(
        this.pubSubClient
          .quit()
          .then(() => {
            logger.debug('Redis pub/sub client disconnected');
          })
          .catch((error: Error) => {
            logger.warn('Error disconnecting Redis pub/sub client:', error);
          }),
      );
    }

    // Wait for all clients to close
    await Promise.all(closePromises);

    // Clear client maps
    this.clients.clear();
    this.pubSubClient = null;

    // Update status
    this.status = RedisConnectionStatus.DISCONNECTED;
    this.emit('status', this.status);
    this.emit('disconnect');

    logger.info('Redis service disconnected');
  }

  /**
   * Get a Redis client from the pool
   */
  public getClient(): RedisClient {
    if (this.clients.size === 0) {
      throw new RedisError('Redis service not connected');
    }

    // Get a random client from the pool
    const clientIds = Array.from(this.clients.keys());
    const randomIndex = Math.floor(Math.random() * clientIds.length);
    const clientId = clientIds[randomIndex];

    return this.clients.get(clientId)!;
  }

  /**
   * Check if Redis is healthy
   */
  public async healthCheck(): Promise<boolean> {
    if (this.clients.size === 0) {
      return false;
    }

    try {
      // Try to ping a client
      const client = this.getClient();
      const result = await client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error('Redis health check failed:', error);
      return false;
    }
  }

  /**
   * Get the current connection status
   */
  public getStatus(): RedisConnectionStatus {
    return this.status;
  }

  /**
   * Set a key with expiration
   */
  public async setWithExpiry(key: string, value: string, expirySeconds: number): Promise<void> {
    const client = this.getClient();
    await client.set(key, value, 'EX', expirySeconds);
  }

  /**
   * Get a value by key
   */
  public async getValue(key: string): Promise<string | null> {
    const client = this.getClient();
    return client.get(key);
  }

  /**
   * Delete a key
   */
  public async deleteKey(key: string): Promise<number> {
    const client = this.getClient();
    return client.del(key);
  }

  /**
   * Check if a key exists
   */
  public async keyExists(key: string): Promise<boolean> {
    const client = this.getClient();
    const result = await client.exists(key);
    return result === 1;
  }

  /**
   * Set multiple key-value pairs
   */
  public async mset(keyValues: Record<string, string>): Promise<void> {
    const client = this.getClient();
    await client.mset(keyValues);
  }

  /**
   * Get multiple values by keys
   */
  public async mget(keys: string[]): Promise<(string | null)[]> {
    const client = this.getClient();
    return client.mget(keys);
  }

  /**
   * Increment a key
   */
  public async increment(key: string, by = 1): Promise<number> {
    const client = this.getClient();
    return by === 1 ? client.incr(key) : client.incrby(key, by);
  }

  /**
   * Decrement a key
   */
  public async decrement(key: string, by = 1): Promise<number> {
    const client = this.getClient();
    return by === 1 ? client.decr(key) : client.decrby(key, by);
  }

  /**
   * Set a key with expiration only if it doesn't exist
   */
  public async setNX(key: string, value: string, expirySeconds?: number): Promise<boolean> {
    const client = this.getClient();

    if (expirySeconds) {
      const result = await client.set(key, value, 'EX', expirySeconds, 'NX');
      return result === 'OK';
    }
    const result = await client.setnx(key, value);
    return result === 1;
  }

  /**
   * Set a hash field
   */
  public async hset(key: string, field: string, value: string): Promise<number> {
    const client = this.getClient();
    return client.hset(key, field, value);
  }

  /**
   * Set multiple hash fields
   */
  public async hmset(key: string, fieldValues: Record<string, string>): Promise<void> {
    const client = this.getClient();
    await client.hmset(key, fieldValues);
  }

  /**
   * Get a hash field
   */
  public async hget(key: string, field: string): Promise<string | null> {
    const client = this.getClient();
    return client.hget(key, field);
  }

  /**
   * Get multiple hash fields
   */
  public async hmget(key: string, fields: string[]): Promise<(string | null)[]> {
    const client = this.getClient();
    return client.hmget(key, ...fields);
  }

  /**
   * Get all hash fields and values
   */
  public async hgetall(key: string): Promise<Record<string, string>> {
    const client = this.getClient();
    return client.hgetall(key);
  }

  /**
   * Delete hash fields
   */
  public async hdel(key: string, ...fields: string[]): Promise<number> {
    const client = this.getClient();
    return client.hdel(key, ...fields);
  }

  /**
   * Check if a hash field exists
   */
  public async hexists(key: string, field: string): Promise<boolean> {
    const client = this.getClient();
    const result = await client.hexists(key, field);
    return result === 1;
  }

  /**
   * Add members to a set
   */
  public async sadd(key: string, ...members: string[]): Promise<number> {
    const client = this.getClient();
    return client.sadd(key, ...members);
  }

  /**
   * Remove members from a set
   */
  public async srem(key: string, ...members: string[]): Promise<number> {
    const client = this.getClient();
    return client.srem(key, ...members);
  }

  /**
   * Get all members of a set
   */
  public async smembers(key: string): Promise<string[]> {
    const client = this.getClient();
    return client.smembers(key);
  }

  /**
   * Check if a member exists in a set
   */
  public async sismember(key: string, member: string): Promise<boolean> {
    const client = this.getClient();
    const result = await client.sismember(key, member);
    return result === 1;
  }

  /**
   * Add a member to a sorted set
   */
  public async zadd(key: string, score: number, member: string): Promise<number> {
    const client = this.getClient();
    return client.zadd(key, score, member);
  }

  /**
   * Get members from a sorted set by score range
   */
  public async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    withScores = false,
  ): Promise<string[]> {
    const client = this.getClient();
    return withScores
      ? client.zrangebyscore(key, min, max, 'WITHSCORES')
      : client.zrangebyscore(key, min, max);
  }

  /**
   * Remove members from a sorted set by score range
   */
  public async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<number> {
    const client = this.getClient();
    return client.zremrangebyscore(key, min, max);
  }

  /**
   * Add elements to a list
   */
  public async lpush(key: string, ...elements: string[]): Promise<number> {
    const client = this.getClient();
    return client.lpush(key, ...elements);
  }

  /**
   * Add elements to the end of a list
   */
  public async rpush(key: string, ...elements: string[]): Promise<number> {
    const client = this.getClient();
    return client.rpush(key, ...elements);
  }

  /**
   * Remove and get the first element of a list
   */
  public async lpop(key: string): Promise<string | null> {
    const client = this.getClient();
    return client.lpop(key);
  }

  /**
   * Remove and get the last element of a list
   */
  public async rpop(key: string): Promise<string | null> {
    const client = this.getClient();
    return client.rpop(key);
  }

  /**
   * Get a range of elements from a list
   */
  public async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const client = this.getClient();
    return client.lrange(key, start, stop);
  }

  /**
   * Execute a transaction
   */
  public async transaction<T>(
    callback: (multi: ReturnType<RedisClient['multi']>) => void,
  ): Promise<T[]> {
    const client = this.getClient();
    const multi = client.multi();

    callback(multi);

    return multi.exec() as Promise<T[]>;
  }

  /**
   * Publish a message to a channel
   */
  public async publish(channel: string, message: string): Promise<number> {
    if (!this.pubSubClient) {
      throw new RedisError('Redis pub/sub client not initialized');
    }

    return this.pubSubClient.publish(channel, message);
  }

  /**
   * Subscribe to a channel
   */
  public async subscribe(
    channel: string,
    callback: (message: RedisPubSubMessage) => void,
  ): Promise<void> {
    if (!this.pubSubClient) {
      throw new RedisError('Redis pub/sub client not initialized');
    }

    // Add the callback to the subscriptions map
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());

      // Subscribe to the channel
      await this.pubSubClient.subscribe(channel);
      logger.debug(`Subscribed to Redis channel: ${channel}`);
    }

    this.subscriptions.get(channel)!.add(callback);
  }

  /**
   * Unsubscribe from a channel
   */
  public async unsubscribe(
    channel: string,
    callback?: (message: RedisPubSubMessage) => void,
  ): Promise<void> {
    if (!this.pubSubClient) {
      return;
    }

    if (!this.subscriptions.has(channel)) {
      return;
    }

    if (callback) {
      // Remove the specific callback
      this.subscriptions.get(channel)!.delete(callback);

      // If there are no more callbacks, unsubscribe from the channel
      if (this.subscriptions.get(channel)!.size === 0) {
        this.subscriptions.delete(channel);
        await this.pubSubClient.unsubscribe(channel);
        logger.debug(`Unsubscribed from Redis channel: ${channel}`);
      }
    } else {
      // Remove all callbacks
      this.subscriptions.delete(channel);
      await this.pubSubClient.unsubscribe(channel);
      logger.debug(`Unsubscribed from Redis channel: ${channel}`);
    }
  }

  /**
   * Subscribe to a pattern
   */
  public async psubscribe(
    pattern: string,
    callback: (message: RedisPubSubMessage) => void,
  ): Promise<void> {
    if (!this.pubSubClient) {
      throw new RedisError('Redis pub/sub client not initialized');
    }

    // Add the callback to the pattern subscriptions map
    if (!this.patternSubscriptions.has(pattern)) {
      this.patternSubscriptions.set(pattern, new Set());

      // Subscribe to the pattern
      await this.pubSubClient.psubscribe(pattern);
      logger.debug(`Subscribed to Redis pattern: ${pattern}`);
    }

    this.patternSubscriptions.get(pattern)!.add(callback);
  }

  /**
   * Unsubscribe from a pattern
   */
  public async punsubscribe(
    pattern: string,
    callback?: (message: RedisPubSubMessage) => void,
  ): Promise<void> {
    if (!this.pubSubClient) {
      return;
    }

    if (!this.patternSubscriptions.has(pattern)) {
      return;
    }

    if (callback) {
      // Remove the specific callback
      this.patternSubscriptions.get(pattern)!.delete(callback);

      // If there are no more callbacks, unsubscribe from the pattern
      if (this.patternSubscriptions.get(pattern)!.size === 0) {
        this.patternSubscriptions.delete(pattern);
        await this.pubSubClient.punsubscribe(pattern);
        logger.debug(`Unsubscribed from Redis pattern: ${pattern}`);
      }
    } else {
      // Remove all callbacks
      this.patternSubscriptions.delete(pattern);
      await this.pubSubClient.punsubscribe(pattern);
      logger.debug(`Unsubscribed from Redis pattern: ${pattern}`);
    }
  }

  /**
   * Initialize the connection pool
   */
  private async initializeConnectionPool(): Promise<void> {
    const poolSize = this.options.poolSize || 10;
    const minPoolSize = this.options.minPoolSize || 2;

    // Create the initial pool of clients
    const initialPoolSize = Math.min(poolSize, Math.max(minPoolSize, 2));

    for (let i = 0; i < initialPoolSize; i++) {
      const clientId = `client-${i}`;
      const client = this.createRedisClient(clientId);

      // Set up event handlers
      this.setupClientEventHandlers(client, clientId);

      // Add to the pool
      this.clients.set(clientId, client);

      // Test connection
      try {
        await client.ping();
        logger.debug(`Redis client ${clientId} connected`);
      } catch (error) {
        logger.error(`Redis client ${clientId} connection failed:`, error);
        throw error;
      }
    }

    logger.info(`Redis connection pool initialized with ${initialPoolSize} clients`);
  }

  /**
   * Initialize the pub/sub client
   */
  private async initializePubSubClient(): Promise<void> {
    const clientId = 'pubsub';
    const client = this.createRedisClient(clientId);

    // Set up event handlers
    this.setupClientEventHandlers(client, clientId);

    // Set up pub/sub event handlers
    client.on('message', (channel: string, message: string) => {
      if (this.subscriptions.has(channel)) {
        const callbacks = this.subscriptions.get(channel)!;
        const messageObj: RedisPubSubMessage = { channel, message };

        for (const callback of callbacks) {
          try {
            callback(messageObj);
          } catch (error) {
            logger.error(`Error in Redis subscription callback for channel ${channel}:`, error);
          }
        }
      }
    });

    client.on('pmessage', (pattern: string, channel: string, message: string) => {
      if (this.patternSubscriptions.has(pattern)) {
        const callbacks = this.patternSubscriptions.get(pattern)!;
        const messageObj: RedisPubSubMessage = { channel, message, pattern };

        for (const callback of callbacks) {
          try {
            callback(messageObj);
          } catch (error) {
            logger.error(
              `Error in Redis pattern subscription callback for pattern ${pattern}:`,
              error,
            );
          }
        }
      }
    });

    // Test connection
    try {
      await client.ping();
      logger.debug('Redis pub/sub client connected');
    } catch (error) {
      logger.error('Redis pub/sub client connection failed:', error);
      throw error;
    }

    this.pubSubClient = client;
  }

  /**
   * Create a new Redis client
   */
  private createRedisClient(clientId: string): RedisClient {
    const connectionName = `${this.options.connectionName || 'redis-service'}-${clientId}`;

    if (this.options.cluster) {
      // Create a cluster client
      if (!this.options.clusterNodes || this.options.clusterNodes.length === 0) {
        throw new RedisError('Cluster nodes must be provided for cluster mode');
      }

      const nodes = this.options.clusterNodes.map(node => ({
        host: node.host,
        port: node.port,
      }));

      const clusterOptions: ClusterOptions = {
        redisOptions: {
          password: this.options.password,
          db: this.options.db,
          keyPrefix: this.options.keyPrefix,
          connectionName,
          tls: this.options.tls ? {} : undefined,
          commandTimeout: this.options.commandTimeout,
          // retryStrategy is handled separately
        },
      };

      return new Redis.Cluster(nodes, clusterOptions);
    }
    // Create a standalone client
    const options: RedisOptions = {
      host: this.options.host,
      port: this.options.port,
      password: this.options.password,
      db: this.options.db,
      keyPrefix: this.options.keyPrefix,
      connectionName,
      tls: this.options.tls ? {} : undefined,
      commandTimeout: this.options.commandTimeout,
      // retryStrategy is handled separately
    };

    return new Redis(options);
  }

  /**
   * Set up event handlers for a Redis client
   */
  private setupClientEventHandlers(client: RedisClient, clientId: string): void {
    client.on('connect', () => {
      logger.debug(`Redis client ${clientId} connected`);
      this.emit('client:connect', clientId);
    });

    client.on('ready', () => {
      logger.debug(`Redis client ${clientId} ready`);
      this.emit('client:ready', clientId);
    });

    client.on('error', (err: Error) => {
      logger.error(`Redis client ${clientId} error:`, err);
      this.emit('client:error', clientId, err);
    });

    client.on('reconnecting', (time: number) => {
      logger.debug(`Redis client ${clientId} reconnecting in ${time}ms`);
      this.emit('client:reconnecting', clientId, time);
    });

    client.on('end', () => {
      logger.debug(`Redis client ${clientId} connection closed`);
      this.emit('client:end', clientId);
    });
  }

  /**
   * Create a retry strategy function for Redis clients
   */
  private createRetryStrategy(): (times: number) => number | void {
    return (times: number) => {
      const maxAttempts = this.options.maxReconnectAttempts || 20;

      if (times > maxAttempts) {
        logger.error(`Redis reconnection failed after ${times} attempts`);
        return;
      }

      const baseDelay = this.options.reconnectDelay || 100;
      const maxDelay = this.options.maxReconnectDelay || 10000;

      // Exponential backoff with jitter
      const delay = Math.min(
        Math.floor(baseDelay * Math.pow(1.5, times) * (0.8 + Math.random() * 0.4)),
        maxDelay,
      );

      logger.debug(`Redis reconnection attempt ${times} in ${delay}ms`);
      return delay;
    };
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const maxAttempts = this.options.maxReconnectAttempts || 20;

    if (this.reconnectAttempts >= maxAttempts) {
      logger.error(`Redis reconnection failed after ${this.reconnectAttempts} attempts`);
      this.emit('reconnect:fail', this.reconnectAttempts);
      return;
    }

    this.reconnectAttempts++;

    const baseDelay = this.options.reconnectDelay || 100;
    const maxDelay = this.options.maxReconnectDelay || 10000;

    // Exponential backoff with jitter
    const delay = Math.min(
      Math.floor(baseDelay * Math.pow(1.5, this.reconnectAttempts) * (0.8 + Math.random() * 0.4)),
      maxDelay,
    );

    logger.info(
      `Redis service reconnection attempt ${this.reconnectAttempts} scheduled in ${delay}ms`,
    );

    this.status = RedisConnectionStatus.RECONNECTING;
    this.emit('status', this.status);
    this.emit('reconnect:schedule', this.reconnectAttempts, delay);

    this.reconnectTimer = setTimeout(async () => {
      try {
        logger.info(`Attempting to reconnect to Redis (attempt ${this.reconnectAttempts})`);
        this.emit('reconnect:attempt', this.reconnectAttempts);

        // Close any existing clients
        await this.disconnect();

        // Try to connect again
        await this.connect();

        // Reset reconnect attempts on success
        this.reconnectAttempts = 0;
        this.emit('reconnect:success');

        logger.info('Redis service reconnected successfully');
      } catch (error) {
        logger.error(`Redis reconnection attempt ${this.reconnectAttempts} failed:`, error);
        this.emit('reconnect:error', this.reconnectAttempts, error);

        // Schedule another reconnection attempt
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Start the health check interval
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Run health check every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      try {
        const isHealthy = await this.healthCheck();

        if (!isHealthy && this.status === RedisConnectionStatus.CONNECTED) {
          logger.warn('Redis health check failed, attempting to reconnect');
          this.scheduleReconnect();
        }
      } catch (error) {
        logger.error('Error during Redis health check:', error);
      }
    }, 30000);
  }
}

// Create and export a singleton instance
export const redisService = new RedisService();

// Export legacy functions for backward compatibility
/**
 * Initialize Redis connection
 * @deprecated Use redisService.connect() instead
 */
export async function initializeRedis(): Promise<Redis> {
  await redisService.connect();
  return redisService.getClient() as Redis;
}

/**
 * Get Redis client instance
 * @deprecated Use redisService.getClient() instead
 */
export function getRedisClient(): Redis {
  return redisService.getClient() as Redis;
}

/**
 * Close Redis connection
 * @deprecated Use redisService.disconnect() instead
 */
export async function closeRedis(): Promise<void> {
  await redisService.disconnect();
}

/**
 * Set a key with expiration
 * @deprecated Use redisService.setWithExpiry() instead
 */
export async function setWithExpiry(
  key: string,
  value: string,
  expirySeconds: number,
): Promise<void> {
  await redisService.setWithExpiry(key, value, expirySeconds);
}

/**
 * Get a value by key
 * @deprecated Use redisService.getValue() instead
 */
export async function getValue(key: string): Promise<string | null> {
  return redisService.getValue(key);
}

/**
 * Delete a key
 * @deprecated Use redisService.deleteKey() instead
 */
export async function deleteKey(key: string): Promise<number> {
  return redisService.deleteKey(key);
}

/**
 * Check if a key exists
 * @deprecated Use redisService.keyExists() instead
 */
export async function keyExists(key: string): Promise<boolean> {
  return redisService.keyExists(key);
}
