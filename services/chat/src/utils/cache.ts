import { getLogger } from '@dome/logging';

/**
 * Cache entry interface
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Cache options interface
 */
export interface CacheOptions {
  ttl: number; // Time to live in milliseconds
  maxSize?: number; // Maximum number of items in the cache
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
}

/**
 * In-memory cache implementation with TTL and LRU eviction
 */
export class Cache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private accessOrder: string[] = []; // For LRU tracking
  private ttl: number;
  private maxSize: number | null;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private logger = getLogger().child({ component: 'Cache' });

  /**
   * Create a new cache
   * @param options Cache options
   */
  constructor(options: CacheOptions) {
    this.ttl = options.ttl;
    this.maxSize = options.maxSize || null;

    this.logger.info(
      {
        ttl: this.ttl,
        maxSize: this.maxSize,
      },
      'Cache initialized',
    );
  }

  /**
   * Set a value in the cache
   * @param key Cache key
   * @param value Value to cache
   */
  set(key: string, value: T): void {
    // Clean expired entries first
    this.cleanExpired();

    // Check if we need to evict an entry due to size constraints
    if (this.maxSize !== null && this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    // Update the cache
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttl,
    });

    // Update access order
    this.updateAccessOrder(key);

    this.logger.debug(
      {
        key,
        cacheSize: this.cache.size,
      },
      'Cache entry set',
    );
  }

  /**
   * Get a value from the cache
   * @param key Cache key
   * @returns Cached value or null if not found or expired
   */
  get(key: string): T | null {
    // Clean expired entries first
    this.cleanExpired();

    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check if the entry is expired
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      this.misses++;
      return null;
    }

    // Update access order
    this.updateAccessOrder(key);

    this.hits++;
    return entry.value;
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
    const deleted = this.cache.delete(key);

    if (deleted) {
      this.removeFromAccessOrder(key);

      this.logger.debug(
        {
          key,
          cacheSize: this.cache.size,
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

    this.logger.info('Cache cleared');
  }

  /**
   * Get cache statistics
   * @returns Cache statistics
   */
  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      maxSize: this.maxSize,
      evictions: this.evictions,
    };
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;

    this.logger.info('Cache statistics reset');
  }

  /**
   * Clean expired entries from the cache
   */
  private cleanExpired(): void {
    const now = Date.now();
    let expiredCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt < now) {
        this.cache.delete(key);
        this.removeFromAccessOrder(key);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      this.logger.debug(
        {
          expiredCount,
          cacheSize: this.cache.size,
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
    this.cache.delete(lruKey);
    this.accessOrder.shift();
    this.evictions++;

    this.logger.debug(
      {
        key: lruKey,
        cacheSize: this.cache.size,
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
 * Global cache instances
 */
const caches: Record<string, Cache<any>> = {};

/**
 * Get or create a cache instance
 * @param name Cache name
 * @param options Cache options
 * @returns Cache instance
 */
export function getCache<T>(name: string, options: CacheOptions): Cache<T> {
  if (!caches[name]) {
    caches[name] = new Cache<T>(options);
  }

  return caches[name] as Cache<T>;
}

/**
 * Get all cache instances
 * @returns Record of cache instances
 */
export function getAllCaches(): Record<string, Cache<any>> {
  return { ...caches };
}

/**
 * Clear all caches
 */
export function clearAllCaches(): void {
  Object.values(caches).forEach(cache => cache.clear());
  getLogger().info('All caches cleared');
}

/**
 * Get statistics for all caches
 * @returns Record of cache statistics
 */
export function getAllCacheStats(): Record<string, CacheStats> {
  const stats: Record<string, CacheStats> = {};

  for (const [name, cache] of Object.entries(caches)) {
    stats[name] = cache.getStats();
  }

  return stats;
}
