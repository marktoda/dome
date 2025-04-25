import { getLogger } from '@dome/logging';

/**
 * Cache entry interface with metadata
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  size: number;
  lastAccessed: number;
  hitCount: number;
}

/**
 * Cache options interface
 */
export interface CacheOptions {
  ttl: number; // Time to live in milliseconds
  maxSize?: number; // Maximum number of items in the cache
  maxMemoryUsage?: number; // Maximum memory usage in bytes (approximate)
  staleWhileRevalidate?: boolean; // Whether to return stale values while revalidating
  segmentCount?: number; // Number of segments for sharded cache (for concurrency)
}

/**
 * Cache statistics interface
 */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  maxSize: number | null;
  evictions: number;
  memoryUsage: number;
  maxMemoryUsage: number | null;
  averageAccessTime: number;
  hitRate: number;
  segmentStats?: Record<string, Omit<CacheStats, 'segmentStats'>>;
}

/**
 * Function type for cache revalidation
 */
export type RevalidateFunction<T> = (key: string, staleValue: T) => Promise<T>;

/**
 * Advanced in-memory cache implementation with TTL, LRU eviction, and memory-aware caching
 */
export class AdvancedCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private accessOrder: string[] = []; // For LRU tracking
  private ttl: number;
  private maxSize: number | null;
  private maxMemoryUsage: number | null;
  private currentMemoryUsage: number = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private accessTimes: number[] = [];
  private staleWhileRevalidate: boolean;
  private revalidationPromises: Map<string, Promise<T>> = new Map();
  private logger = getLogger().child({ component: 'AdvancedCache' });

  /**
   * Create a new advanced cache
   * @param options Cache options
   */
  constructor(options: CacheOptions) {
    this.ttl = options.ttl;
    this.maxSize = options.maxSize || null;
    this.maxMemoryUsage = options.maxMemoryUsage || null;
    this.staleWhileRevalidate = options.staleWhileRevalidate || false;

    this.logger.info(
      {
        ttl: this.ttl,
        maxSize: this.maxSize,
        maxMemoryUsage: this.maxMemoryUsage,
        staleWhileRevalidate: this.staleWhileRevalidate,
      },
      'Advanced cache initialized',
    );
  }

  /**
   * Estimate the size of a value in bytes
   * @param value Value to estimate size for
   * @returns Estimated size in bytes
   */
  private estimateSize(value: T): number {
    // Basic size estimation - this is approximate
    const jsonString = JSON.stringify(value);
    return jsonString ? jsonString.length * 2 : 0; // Unicode characters can be up to 2 bytes
  }

  /**
   * Set a value in the cache
   * @param key Cache key
   * @param value Value to cache
   * @returns The cache entry
   */
  set(key: string, value: T): CacheEntry<T> {
    // Clean expired entries first
    this.cleanExpired();

    // Estimate the size of the value
    const size = this.estimateSize(value);

    // Check if we need to evict entries due to memory constraints
    if (this.maxMemoryUsage !== null) {
      while (this.currentMemoryUsage + size > this.maxMemoryUsage && this.cache.size > 0) {
        this.evictLRU();
      }
    }

    // Check if we need to evict an entry due to size constraints
    if (this.maxSize !== null && this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    // If the key already exists, subtract its size from the current memory usage
    if (this.cache.has(key)) {
      this.currentMemoryUsage -= this.cache.get(key)!.size;
    }

    // Create the cache entry
    const entry: CacheEntry<T> = {
      value,
      expiresAt: Date.now() + this.ttl,
      size,
      lastAccessed: Date.now(),
      hitCount: 0,
    };

    // Update the cache
    this.cache.set(key, entry);
    this.currentMemoryUsage += size;

    // Update access order
    this.updateAccessOrder(key);

    this.logger.debug(
      {
        key,
        cacheSize: this.cache.size,
        memoryUsage: this.currentMemoryUsage,
        valueSize: size,
      },
      'Cache entry set',
    );

    return entry;
  }

  /**
   * Get a value from the cache
   * @param key Cache key
   * @returns Cached value or null if not found or expired
   */
  get(key: string): T | null {
    const startTime = performance.now();

    // Clean expired entries first
    this.cleanExpired();

    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check if the entry is expired
    const now = Date.now();
    if (entry.expiresAt < now) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      this.currentMemoryUsage -= entry.size;
      this.misses++;
      return null;
    }

    // Update access metadata
    entry.lastAccessed = now;
    entry.hitCount++;

    // Update access order
    this.updateAccessOrder(key);

    // Track access time
    const accessTime = performance.now() - startTime;
    this.accessTimes.push(accessTime);
    if (this.accessTimes.length > 100) {
      this.accessTimes.shift();
    }

    this.hits++;
    return entry.value;
  }

  /**
   * Get a value from the cache with revalidation support
   * @param key Cache key
   * @param revalidate Function to revalidate the value if expired
   * @returns Cached value (possibly stale) or null if not found
   */
  async getWithRevalidation(key: string, revalidate: RevalidateFunction<T>): Promise<T | null> {
    const entry = this.cache.get(key);
    const now = Date.now();

    // If no entry exists, return null
    if (!entry) {
      this.misses++;
      return null;
    }

    // If entry is fresh, return it
    if (entry.expiresAt >= now) {
      // Update access metadata
      entry.lastAccessed = now;
      entry.hitCount++;

      // Update access order
      this.updateAccessOrder(key);

      this.hits++;
      return entry.value;
    }

    // Entry is stale

    // If staleWhileRevalidate is enabled, trigger revalidation and return stale value
    if (this.staleWhileRevalidate) {
      // Check if revalidation is already in progress
      if (!this.revalidationPromises.has(key)) {
        // Start revalidation
        const revalidationPromise = revalidate(key, entry.value)
          .then(newValue => {
            // Update cache with new value
            this.set(key, newValue);
            // Remove from revalidation promises
            this.revalidationPromises.delete(key);
            return newValue;
          })
          .catch(error => {
            this.logger.error({ key, error }, 'Error revalidating cache entry');
            // Remove from revalidation promises
            this.revalidationPromises.delete(key);
            // Return the stale value on error
            return entry.value;
          });

        this.revalidationPromises.set(key, revalidationPromise);
      }

      // Return stale value while revalidating
      this.hits++;
      return entry.value;
    }

    // If staleWhileRevalidate is disabled, remove the stale entry and return null
    this.cache.delete(key);
    this.removeFromAccessOrder(key);
    this.currentMemoryUsage -= entry.size;
    this.misses++;
    return null;
  }

  /**
   * Check if a key exists in the cache and is not expired
   * @param key Cache key
   * @returns True if the key exists and is not expired
   */
  has(key: string): boolean {
    // Clean expired entries first
    this.cleanExpired();

    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    // Check if the entry is expired
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      this.currentMemoryUsage -= entry.size;
      return false;
    }

    return true;
  }

  /**
   * Delete a key from the cache
   * @param key Cache key
   * @returns True if the key was deleted
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    const deleted = this.cache.delete(key);

    if (deleted) {
      this.removeFromAccessOrder(key);
      this.currentMemoryUsage -= entry.size;

      this.logger.debug(
        {
          key,
          cacheSize: this.cache.size,
          memoryUsage: this.currentMemoryUsage,
        },
        'Cache entry deleted',
      );
    }

    return deleted;
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.currentMemoryUsage = 0;
    this.revalidationPromises.clear();

    this.logger.info('Cache cleared');
  }

  /**
   * Get cache statistics
   * @returns Cache statistics
   */
  getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      maxSize: this.maxSize,
      evictions: this.evictions,
      memoryUsage: this.currentMemoryUsage,
      maxMemoryUsage: this.maxMemoryUsage,
      averageAccessTime:
        this.accessTimes.length > 0
          ? this.accessTimes.reduce((sum, time) => sum + time, 0) / this.accessTimes.length
          : 0,
      hitRate,
    };
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.accessTimes = [];

    this.logger.info('Cache statistics reset');
  }

  /**
   * Clean expired entries from the cache
   */
  private cleanExpired(): void {
    const now = Date.now();
    let expiredCount = 0;
    let freedMemory = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt < now) {
        this.cache.delete(key);
        this.removeFromAccessOrder(key);
        this.currentMemoryUsage -= entry.size;
        freedMemory += entry.size;
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      this.logger.debug(
        {
          expiredCount,
          freedMemory,
          cacheSize: this.cache.size,
          memoryUsage: this.currentMemoryUsage,
        },
        'Expired cache entries cleaned',
      );
    }
  }

  /**
   * Evict the least recently used entry
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) {
      return;
    }

    const lruKey = this.accessOrder[0];
    const entry = this.cache.get(lruKey);

    if (!entry) {
      // This shouldn't happen, but just in case
      this.accessOrder.shift();
      return;
    }

    this.cache.delete(lruKey);
    this.accessOrder.shift();
    this.currentMemoryUsage -= entry.size;
    this.evictions++;

    this.logger.debug(
      {
        key: lruKey,
        freedMemory: entry.size,
        cacheSize: this.cache.size,
        memoryUsage: this.currentMemoryUsage,
      },
      'LRU cache entry evicted',
    );
  }

  /**
   * Update the access order for a key
   * @param key Cache key
   */
  private updateAccessOrder(key: string): void {
    // Remove the key from its current position
    this.removeFromAccessOrder(key);

    // Add the key to the end of the access order (most recently used)
    this.accessOrder.push(key);
  }

  /**
   * Remove a key from the access order
   * @param key Cache key
   */
  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);

    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }
}

/**
 * Sharded cache implementation for high concurrency
 */
export class ShardedCache<T> {
  private shards: AdvancedCache<T>[];
  private shardCount: number;
  private logger = getLogger().child({ component: 'ShardedCache' });

  /**
   * Create a new sharded cache
   * @param options Cache options
   */
  constructor(options: CacheOptions) {
    this.shardCount = options.segmentCount || 4;

    // Create shards with distributed memory and size limits
    this.shards = Array.from({ length: this.shardCount }, (_, i) => {
      const shardOptions: CacheOptions = {
        ...options,
        maxSize: options.maxSize ? Math.ceil(options.maxSize / this.shardCount) : undefined,
        maxMemoryUsage: options.maxMemoryUsage
          ? Math.ceil(options.maxMemoryUsage / this.shardCount)
          : undefined,
      };

      return new AdvancedCache<T>(shardOptions);
    });

    this.logger.info(
      {
        shardCount: this.shardCount,
        ttl: options.ttl,
        maxSize: options.maxSize,
        maxMemoryUsage: options.maxMemoryUsage,
      },
      'Sharded cache initialized',
    );
  }

  /**
   * Get the shard for a key
   * @param key Cache key
   * @returns Shard for the key
   */
  private getShard(key: string): AdvancedCache<T> {
    // Simple hash function to determine shard
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }

    // Get positive hash value
    const positiveHash = Math.abs(hash);

    // Get shard index
    const shardIndex = positiveHash % this.shardCount;

    return this.shards[shardIndex];
  }

  /**
   * Set a value in the cache
   * @param key Cache key
   * @param value Value to cache
   */
  set(key: string, value: T): void {
    const shard = this.getShard(key);
    shard.set(key, value);
  }

  /**
   * Get a value from the cache
   * @param key Cache key
   * @returns Cached value or null if not found or expired
   */
  get(key: string): T | null {
    const shard = this.getShard(key);
    return shard.get(key);
  }

  /**
   * Get a value from the cache with revalidation support
   * @param key Cache key
   * @param revalidate Function to revalidate the value if expired
   * @returns Cached value (possibly stale) or null if not found
   */
  async getWithRevalidation(key: string, revalidate: RevalidateFunction<T>): Promise<T | null> {
    const shard = this.getShard(key);
    return shard.getWithRevalidation(key, revalidate);
  }

  /**
   * Check if a key exists in the cache and is not expired
   * @param key Cache key
   * @returns True if the key exists and is not expired
   */
  has(key: string): boolean {
    const shard = this.getShard(key);
    return shard.has(key);
  }

  /**
   * Delete a key from the cache
   * @param key Cache key
   * @returns True if the key was deleted
   */
  delete(key: string): boolean {
    const shard = this.getShard(key);
    return shard.delete(key);
  }

  /**
   * Clear the cache
   */
  clear(): void {
    for (const shard of this.shards) {
      shard.clear();
    }

    this.logger.info('All shards cleared');
  }

  /**
   * Get cache statistics
   * @returns Cache statistics
   */
  getStats(): CacheStats {
    // Collect stats from all shards
    const shardStats = this.shards.map(shard => shard.getStats());

    // Aggregate stats
    const aggregatedStats: CacheStats = {
      hits: 0,
      misses: 0,
      size: 0,
      maxSize: 0,
      evictions: 0,
      memoryUsage: 0,
      maxMemoryUsage: 0,
      averageAccessTime: 0,
      hitRate: 0,
      segmentStats: {},
    };

    // Sum up stats
    for (let i = 0; i < shardStats.length; i++) {
      const stats = shardStats[i];

      aggregatedStats.hits += stats.hits;
      aggregatedStats.misses += stats.misses;
      aggregatedStats.size += stats.size;
      aggregatedStats.evictions += stats.evictions;
      aggregatedStats.memoryUsage += stats.memoryUsage;

      if (stats.maxSize !== null) {
        aggregatedStats.maxSize = (aggregatedStats.maxSize || 0) + stats.maxSize;
      }

      if (stats.maxMemoryUsage !== null) {
        aggregatedStats.maxMemoryUsage =
          (aggregatedStats.maxMemoryUsage || 0) + stats.maxMemoryUsage;
      }

      // Store individual shard stats
      aggregatedStats.segmentStats![`shard-${i}`] = stats;
    }

    // Calculate averages
    const totalRequests = aggregatedStats.hits + aggregatedStats.misses;
    aggregatedStats.hitRate = totalRequests > 0 ? aggregatedStats.hits / totalRequests : 0;

    // Calculate weighted average access time
    let totalAccessTimeWeight = 0;
    let weightedAccessTimeSum = 0;

    for (const stats of shardStats) {
      const weight = stats.hits;
      totalAccessTimeWeight += weight;
      weightedAccessTimeSum += stats.averageAccessTime * weight;
    }

    aggregatedStats.averageAccessTime =
      totalAccessTimeWeight > 0 ? weightedAccessTimeSum / totalAccessTimeWeight : 0;

    return aggregatedStats;
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    for (const shard of this.shards) {
      shard.resetStats();
    }

    this.logger.info('All shard statistics reset');
  }
}

/**
 * Global cache instances
 */
const caches: Record<string, ShardedCache<any> | AdvancedCache<any>> = {};

/**
 * Get or create a cache instance
 * @param name Cache name
 * @param options Cache options
 * @returns Cache instance
 */
export function getAdvancedCache<T>(
  name: string,
  options: CacheOptions,
): ShardedCache<T> | AdvancedCache<T> {
  if (!caches[name]) {
    // Create sharded cache if segmentCount is specified
    if (options.segmentCount && options.segmentCount > 1) {
      caches[name] = new ShardedCache<T>(options);
    } else {
      caches[name] = new AdvancedCache<T>(options);
    }
  }

  return caches[name] as ShardedCache<T> | AdvancedCache<T>;
}

/**
 * Get all cache instances
 * @returns Record of cache instances
 */
export function getAllAdvancedCaches(): Record<string, ShardedCache<any> | AdvancedCache<any>> {
  return { ...caches };
}

/**
 * Clear all caches
 */
export function clearAllAdvancedCaches(): void {
  Object.values(caches).forEach(cache => cache.clear());
  getLogger().info('All advanced caches cleared');
}

/**
 * Get statistics for all caches
 * @returns Record of cache statistics
 */
export function getAllAdvancedCacheStats(): Record<string, CacheStats> {
  const stats: Record<string, CacheStats> = {};

  for (const [name, cache] of Object.entries(caches)) {
    stats[name] = cache.getStats();
  }

  return stats;
}
