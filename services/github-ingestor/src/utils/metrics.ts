import { metrics as domeMetrics } from '@dome/logging';

/**
 * Metrics service for GitHub Ingestor
 * Wraps the common metrics service with GitHub-specific tags and naming
 */
export class GitHubIngestorMetrics {
  private readonly prefix = 'github_ingestor';
  private defaultTagsBase: Record<string, string>;
  private envTags: Record<string, string> = {};
  // Internal counters for tracking metrics in memory
  private counters: Map<string, number> = new Map();

  constructor() {
    this.defaultTagsBase = {
      service: 'github-ingestor',
      version: 'unknown', // Will be set during initialization
      environment: 'development', // Will be set during initialization
    };
  }

  /**
   * Initialize metrics with environment variables
   * @param env Environment variables
   */
  public init(env: { VERSION: string; ENVIRONMENT: string }): void {
    this.envTags = {
      version: env.VERSION || 'unknown',
      environment: env.ENVIRONMENT || 'development',
    };
  }

  /**
   * Get the combined default tags
   */
  private get defaultTags(): Record<string, string> {
    return { ...this.defaultTagsBase, ...this.envTags };
  }

  /**
   * Add default tags to user-provided tags
   * @param tags User-provided tags
   * @returns Combined tags
   */
  private addDefaultTags(tags: Record<string, string> = {}): Record<string, string> {
    return { ...this.defaultTags, ...tags };
  }

  /**
   * Increment a counter metric
   * @param name Metric name
   * @param value Amount to increment by (default: 1)
   * @param tags Additional tags
   */
  public counter(name: string, value = 1, tags: Record<string, string> = {}): void {
    // Update internal counter
    const currentValue = this.counters.get(name) || 0;
    this.counters.set(name, currentValue + value);

    // Send to metrics service
    domeMetrics.increment(`${this.prefix}.${name}`, value, this.addDefaultTags(tags));
  }

  /**
   * Set a gauge metric
   * @param name Metric name
   * @param value Gauge value
   * @param tags Additional tags
   */
  public gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    domeMetrics.gauge(`${this.prefix}.${name}`, value, this.addDefaultTags(tags));
  }

  /**
   * Record a timing metric
   * @param name Metric name
   * @param value Timing value in milliseconds
   * @param tags Additional tags
   */
  public timing(name: string, value: number, tags: Record<string, string> = {}): void {
    domeMetrics.timing(`${this.prefix}.${name}`, value, this.addDefaultTags(tags));
  }

  /**
   * Create a timer for measuring operation duration
   * @param name Operation name
   * @param tags Additional tags to include when the timer stops
   * @returns Timer object with stop method
   */
  public startTimer(name: string, tags: Record<string, string> = {}) {
    const startTime = performance.now();

    return {
      stop: (additionalTags: Record<string, string> = {}) => {
        const duration = Math.round(performance.now() - startTime);
        this.timing(`${name}.duration_ms`, duration, { ...tags, ...additionalTags });
        return duration;
      },
    };
  }

  /**
   * Track the success or failure of an operation
   * @param name Operation name
   * @param success Whether the operation succeeded
   * @param tags Additional tags
   */
  public trackOperation(name: string, success: boolean, tags: Record<string, string> = {}): void {
    const metricName = `${name}.${success ? 'success' : 'failure'}`;
    this.counter(metricName, 1, tags);

    // Also track as a gauge for success rate calculation
    this.gauge(`${name}.success_rate`, success ? 1 : 0, tags);
  }

  /**
   * Track GitHub API rate limit usage
   * @param remaining Remaining API calls
   * @param limit Total API call limit
   * @param reset Reset timestamp (epoch seconds)
   * @param scope API scope (e.g., 'core', 'search')
   * @param owner Repository owner (optional)
   */
  public trackRateLimit(
    remaining: number,
    limit: number,
    reset: number,
    scope: string = 'core',
    owner?: string,
  ): void {
    const tags: Record<string, string> = { scope };
    if (owner) tags.owner = owner;

    this.gauge('github_api.rate_limit.remaining', remaining, tags);
    this.gauge('github_api.rate_limit.limit', limit, tags);
    this.gauge('github_api.rate_limit.reset', reset, tags);
    this.gauge('github_api.rate_limit.usage_percent', 100 - (remaining / limit) * 100, tags);

    // Track if we're approaching the limit (less than 10% remaining)
    if (remaining / limit < 0.1) {
      this.counter('github_api.rate_limit.approaching_limit', 1, tags);
    }
  }

  /**
   * Track repository ingestion metrics
   * @param owner Repository owner
   * @param repo Repository name
   * @param fileCount Number of files processed
   * @param totalSize Total size in bytes
   * @param duration Processing duration in milliseconds
   * @param isPrivate Whether the repository is private
   */
  public trackRepositoryIngestion(
    owner: string,
    repo: string,
    fileCount: number,
    totalSize: number,
    duration: number,
    isPrivate: boolean,
  ): void {
    const tags = {
      owner,
      repo,
      is_private: isPrivate.toString(),
    };

    this.counter('repository.files_processed', fileCount, tags);
    this.counter('repository.bytes_processed', totalSize, tags);
    this.timing('repository.processing_time_ms', duration, tags);
    this.gauge('repository.processing_speed_kbps', totalSize / 1024 / (duration / 1000), tags);
    this.gauge('repository.avg_file_size_bytes', totalSize / Math.max(1, fileCount), tags);
  }

  /**
   * Track API request metrics
   * @param path Request path
   * @param method HTTP method
   * @param statusCode HTTP status code
   * @param duration Request duration in milliseconds
   */
  public trackApiRequest(path: string, method: string, statusCode: number, duration: number): void {
    const tags = {
      path,
      method,
      status_code: statusCode.toString(),
      status_category: Math.floor(statusCode / 100).toString() + 'xx',
    };

    this.counter('api.request', 1, tags);
    this.timing('api.request_duration_ms', duration, tags);

    // Track errors separately
    if (statusCode >= 400) {
      this.counter('api.error', 1, tags);
    }
  }

  /**
   * Track queue processing metrics
   * @param queueName Name of the queue
   * @param messageCount Number of messages processed
   * @param successCount Number of successfully processed messages
   * @param duration Processing duration in milliseconds
   */
  public trackQueueProcessing(
    queueName: string,
    messageCount: number,
    successCount: number,
    duration: number,
  ): void {
    const tags = { queue: queueName };

    this.counter('queue.messages_processed', messageCount, tags);
    this.counter('queue.messages_succeeded', successCount, tags);
    this.counter('queue.messages_failed', messageCount - successCount, tags);
    this.timing('queue.batch_processing_ms', duration, tags);
    this.gauge('queue.success_rate', (successCount / Math.max(1, messageCount)) * 100, tags);
    this.gauge('queue.messages_per_second', messageCount / (duration / 1000), tags);
  }

  /**
   * Track webhook processing metrics
   * @param event Webhook event type
   * @param statusCode HTTP status code
   * @param duration Processing duration in milliseconds
   * @param owner Repository owner (optional)
   */
  public trackWebhookProcessing(
    event: string,
    statusCode: number,
    duration: number,
    owner?: string,
  ): void {
    const tags: Record<string, string> = {
      event,
      status_code: statusCode.toString(),
    };

    if (owner) tags.owner = owner;

    this.counter('webhook.received', 1, tags);
    this.timing('webhook.processing_ms', duration, tags);

    // Track errors separately
    if (statusCode >= 400) {
      this.counter('webhook.error', 1, tags);
    }
  }

  /**
   * Track health check metrics
   * @param status Health check status (ok, warning, error)
   * @param duration Check duration in milliseconds
   * @param component Component being checked (optional)
   */
  public trackHealthCheck(
    status: 'ok' | 'warning' | 'error',
    duration: number,
    component?: string,
  ): void {
    const tags: Record<string, string> = { status };
    if (component) tags.component = component;

    this.counter('health.check', 1, tags);
    this.timing('health.check_duration_ms', duration, tags);

    // Track a numeric value for the status (0 = error, 1 = warning, 2 = ok)
    // This makes it easier to create alerts based on status
    const statusValue = status === 'ok' ? 2 : status === 'warning' ? 1 : 0;
    this.gauge('health.status', statusValue, tags);
  }

  /**
   * Get the current value of a counter
   * @param name Counter name
   * @returns Current counter value
   */
  public getCounter(name: string): number {
    return this.counters.get(name) || 0;
  }
}

/**
 * Singleton metrics service instance
 */
export const metrics = new GitHubIngestorMetrics();
