import { getLogger } from '@dome/logging';

/**
 * Object pool configuration
 */
export interface ObjectPoolConfig<T> {
  name: string;
  initialSize: number;
  maxSize: number;
  factory: () => T;
  reset: (obj: T) => void;
}

/**
 * Object pool statistics
 */
export interface ObjectPoolStats {
  name: string;
  size: number;
  maxSize: number;
  available: number;
  created: number;
  acquired: number;
  released: number;
  resized: number;
}

/**
 * Generic object pool for reducing allocations
 */
export class ObjectPool<T> {
  private pool: T[] = [];
  private name: string;
  private maxSize: number;
  private factory: () => T;
  private reset: (obj: T) => void;
  private created = 0;
  private acquired = 0;
  private released = 0;
  private resized = 0;
  private logger = getLogger();

  /**
   * Create a new object pool
   * @param config Pool configuration
   */
  constructor(config: ObjectPoolConfig<T>) {
    this.name = config.name;
    this.maxSize = config.maxSize;
    this.factory = config.factory;
    this.reset = config.reset;
    this.logger = getLogger().child({ component: 'ObjectPool', pool: config.name });

    // Initialize the pool with the initial size
    this.initialize(config.initialSize);

    this.logger.info(
      {
        name: this.name,
        initialSize: config.initialSize,
        maxSize: this.maxSize,
      },
      'Object pool initialized',
    );
  }

  /**
   * Initialize the pool with a given size
   * @param size Initial pool size
   */
  private initialize(size: number): void {
    for (let i = 0; i < size; i++) {
      const obj = this.factory();
      this.pool.push(obj);
      this.created++;
    }
  }

  /**
   * Acquire an object from the pool
   * @returns Pooled object
   */
  acquire(): T {
    let obj: T;

    if (this.pool.length > 0) {
      // Get an object from the pool
      obj = this.pool.pop()!;
    } else {
      // Create a new object if the pool is empty
      obj = this.factory();
      this.created++;

      this.logger.debug(
        {
          name: this.name,
          poolSize: this.pool.length,
          created: this.created,
        },
        'Created new object for pool',
      );
    }

    this.acquired++;
    return obj;
  }

  /**
   * Release an object back to the pool
   * @param obj Object to release
   */
  release(obj: T): void {
    // Reset the object
    this.reset(obj);

    // Add the object back to the pool if we're not at max size
    if (this.pool.length < this.maxSize) {
      this.pool.push(obj);
    }

    this.released++;
  }

  /**
   * Resize the pool
   * @param newSize New maximum size
   */
  resize(newSize: number): void {
    if (newSize < 0) {
      throw new Error('Pool size cannot be negative');
    }

    this.maxSize = newSize;

    // If the new size is smaller than the current pool size,
    // remove excess objects
    while (this.pool.length > this.maxSize) {
      this.pool.pop();
    }

    this.resized++;

    this.logger.info(
      {
        name: this.name,
        newSize: this.maxSize,
        currentSize: this.pool.length,
      },
      'Object pool resized',
    );
  }

  /**
   * Get pool statistics
   * @returns Pool statistics
   */
  getStats(): ObjectPoolStats {
    return {
      name: this.name,
      size: this.pool.length,
      maxSize: this.maxSize,
      available: this.pool.length,
      created: this.created,
      acquired: this.acquired,
      released: this.released,
      resized: this.resized,
    };
  }

  /**
   * Clear the pool
   */
  clear(): void {
    this.pool = [];

    this.logger.info({ name: this.name }, 'Object pool cleared');
  }
}

/**
 * Global object pools registry
 */
const objectPools: Record<string, ObjectPool<any>> = {};

/**
 * Get or create an object pool
 * @param config Pool configuration
 * @returns Object pool instance
 */
export function getObjectPool<T>(config: ObjectPoolConfig<T>): ObjectPool<T> {
  if (!objectPools[config.name]) {
    objectPools[config.name] = new ObjectPool<T>(config);
  }

  return objectPools[config.name] as ObjectPool<T>;
}

/**
 * Get all object pools
 * @returns Record of object pools
 */
export function getAllObjectPools(): Record<string, ObjectPool<any>> {
  return { ...objectPools };
}

/**
 * Get statistics for all object pools
 * @returns Record of object pool statistics
 */
export function getAllObjectPoolStats(): Record<string, ObjectPoolStats> {
  const stats: Record<string, ObjectPoolStats> = {};

  for (const [name, pool] of Object.entries(objectPools)) {
    stats[name] = pool.getStats();
  }

  return stats;
}

/**
 * Buffer pool for efficient binary data handling
 */
export class BufferPool {
  private static readonly DEFAULT_CHUNK_SIZE = 4096; // 4KB
  private static readonly pool = getObjectPool<Uint8Array>({
    name: 'bufferPool',
    initialSize: 10,
    maxSize: 100,
    factory: () => new Uint8Array(BufferPool.DEFAULT_CHUNK_SIZE),
    reset: buffer => {
      buffer.fill(0);
    },
  });

  /**
   * Acquire a buffer from the pool
   * @param size Minimum buffer size
   * @returns Buffer from the pool
   */
  static acquire(size: number = BufferPool.DEFAULT_CHUNK_SIZE): Uint8Array {
    if (size <= BufferPool.DEFAULT_CHUNK_SIZE) {
      return BufferPool.pool.acquire();
    } else {
      // For larger buffers, create a new one (not pooled)
      return new Uint8Array(size);
    }
  }

  /**
   * Release a buffer back to the pool
   * @param buffer Buffer to release
   */
  static release(buffer: Uint8Array): void {
    if (buffer.length === BufferPool.DEFAULT_CHUNK_SIZE) {
      BufferPool.pool.release(buffer);
    }
    // Larger buffers are not returned to the pool
  }

  /**
   * Get pool statistics
   * @returns Pool statistics
   */
  static getStats(): ObjectPoolStats {
    return BufferPool.pool.getStats();
  }
}

/**
 * String interning for reducing memory usage with repeated strings
 */
export class StringInterner {
  private static readonly strings = new Map<string, string>();
  private static hits = 0;
  private static misses = 0;

  /**
   * Intern a string
   * @param str String to intern
   * @returns Interned string
   */
  static intern(str: string): string {
    if (StringInterner.strings.has(str)) {
      StringInterner.hits++;
      return StringInterner.strings.get(str)!;
    } else {
      StringInterner.misses++;
      StringInterner.strings.set(str, str);
      return str;
    }
  }

  /**
   * Get statistics
   * @returns Statistics object
   */
  static getStats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = StringInterner.hits + StringInterner.misses;
    const hitRate = total > 0 ? StringInterner.hits / total : 0;

    return {
      size: StringInterner.strings.size,
      hits: StringInterner.hits,
      misses: StringInterner.misses,
      hitRate,
    };
  }

  /**
   * Clear the interned strings
   */
  static clear(): void {
    StringInterner.strings.clear();
    StringInterner.hits = 0;
    StringInterner.misses = 0;
  }
}

/**
 * Stream utilities for efficient data processing
 */
export class StreamUtils {
  /**
   * Create a transform stream that processes chunks in batches
   * @param batchSize Maximum batch size
   * @param processBatch Function to process a batch of chunks
   * @returns TransformStream
   */
  static createBatchingTransform<T, R>(
    batchSize: number,
    processBatch: (batch: T[]) => Promise<R[]>,
  ): TransformStream<T, R> {
    let batch: T[] = [];

    return new TransformStream<T, R>({
      async transform(chunk, controller) {
        batch.push(chunk);

        if (batch.length >= batchSize) {
          const results = await processBatch(batch);
          for (const result of results) {
            controller.enqueue(result);
          }
          batch = [];
        }
      },
      async flush(controller) {
        if (batch.length > 0) {
          const results = await processBatch(batch);
          for (const result of results) {
            controller.enqueue(result);
          }
        }
      },
    });
  }

  /**
   * Create a transform stream that filters chunks
   * @param predicate Function to determine if a chunk should be included
   * @returns TransformStream
   */
  static createFilterTransform<T>(predicate: (chunk: T) => boolean): TransformStream<T, T> {
    return new TransformStream<T, T>({
      transform(chunk, controller) {
        if (predicate(chunk)) {
          controller.enqueue(chunk);
        }
      },
    });
  }

  /**
   * Create a transform stream that maps chunks
   * @param mapper Function to map chunks
   * @returns TransformStream
   */
  static createMapTransform<T, R>(mapper: (chunk: T) => R): TransformStream<T, R> {
    return new TransformStream<T, R>({
      transform(chunk, controller) {
        controller.enqueue(mapper(chunk));
      },
    });
  }

  /**
   * Create a transform stream that limits the number of chunks
   * @param limit Maximum number of chunks
   * @returns TransformStream
   */
  static createLimitTransform<T>(limit: number): TransformStream<T, T> {
    let count = 0;

    return new TransformStream<T, T>({
      transform(chunk, controller) {
        if (count < limit) {
          controller.enqueue(chunk);
          count++;
        }
      },
    });
  }
}

/**
 * Memory usage information
 */
interface MemoryUsage {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

/**
 * Memory usage tracker
 */
export class MemoryTracker {
  private static readonly samples: Array<{ timestamp: number; usage: MemoryUsage }> = [];
  private static readonly MAX_SAMPLES = 100;
  private static interval: NodeJS.Timeout | null = null;
  private static readonly SAMPLE_INTERVAL_MS = 60000; // 1 minute

  /**
   * Start tracking memory usage
   * @param intervalMs Sample interval in milliseconds
   */
  static startTracking(intervalMs: number = MemoryTracker.SAMPLE_INTERVAL_MS): void {
    if (MemoryTracker.interval) {
      clearInterval(MemoryTracker.interval);
    }

    // Take an initial sample
    MemoryTracker.takeSample();

    // Set up the interval
    MemoryTracker.interval = setInterval(() => {
      MemoryTracker.takeSample();
    }, intervalMs);

    getLogger().info({ intervalMs }, 'Started memory usage tracking');
  }

  /**
   * Stop tracking memory usage
   */
  static stopTracking(): void {
    if (MemoryTracker.interval) {
      clearInterval(MemoryTracker.interval);
      MemoryTracker.interval = null;

      getLogger().info('Stopped memory usage tracking');
    }
  }

  /**
   * Take a memory usage sample
   */
  static takeSample(): void {
    // Check if process.memoryUsage is available (Node.js environment)
    if (typeof process !== 'undefined' && typeof process.memoryUsage === 'function') {
      const usage = process.memoryUsage();

      MemoryTracker.samples.push({
        timestamp: Date.now(),
        usage: {
          heapUsed: usage.heapUsed,
          heapTotal: usage.heapTotal,
          external: usage.external,
          rss: usage.rss,
        },
      });

      // Limit the number of samples
      if (MemoryTracker.samples.length > MemoryTracker.MAX_SAMPLES) {
        MemoryTracker.samples.shift();
      }

      getLogger().debug(
        {
          heapUsedMB: Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100,
          heapTotalMB: Math.round((usage.heapTotal / 1024 / 1024) * 100) / 100,
          rssMB: Math.round((usage.rss / 1024 / 1024) * 100) / 100,
        },
        'Memory usage sample',
      );
    }
  }

  /**
   * Get memory usage samples
   * @returns Array of memory usage samples
   */
  static getSamples(): Array<{ timestamp: number; usage: MemoryUsage }> {
    return [...MemoryTracker.samples];
  }

  /**
   * Get the current memory usage
   * @returns Current memory usage or null if not available
   */
  static getCurrentUsage(): MemoryUsage | null {
    if (typeof process !== 'undefined' && typeof process.memoryUsage === 'function') {
      const usage = process.memoryUsage();

      return {
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external,
        rss: usage.rss,
      };
    }

    return null;
  }

  /**
   * Clear all samples
   */
  static clearSamples(): void {
    MemoryTracker.samples.length = 0;

    getLogger().info('Cleared memory usage samples');
  }
}

// Start memory tracking if in a Node.js environment
if (typeof process !== 'undefined' && typeof process.memoryUsage === 'function') {
  MemoryTracker.startTracking();
}
