/// <reference types="../worker-configuration" />

/**
 * Environment interface that extends the generated Cloudflare.Env
 * Contains all bindings (D1, R2, Queues, Service bindings) and environment variables
 */
export interface Env {
  // GitHub-related environment variables
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  
  // Service bindings
  SILO: Fetcher; // Silo service binding for content storage
  
  // Database bindings
  DB: D1Database; // D1 database for metadata storage
  
  // Queue bindings
  INGEST_QUEUE: Queue<IngestMessage>; // Queue for ingestion tasks
  DEAD_LETTER_QUEUE: Queue<DeadLetterMessage>; // Queue for failed ingestion tasks
  
  // Environment configuration
  LOG_LEVEL: "info" | "debug";
  VERSION: string;
  ENVIRONMENT: "prod" | "dev" | "staging";
}

/**
 * Interface for execution context
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
  props: any;
}

/**
 * Interface for scheduled controller
 */
export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

/**
 * Interface for queue message
 */
export interface Message<Body = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  readonly attempts: number;
  retry(options?: QueueRetryOptions): void;
  ack(): void;
}

/**
 * Interface for queue retry options
 */
export interface QueueRetryOptions {
  delaySeconds?: number;
}

/**
 * Interface for queue message batch
 */
export interface MessageBatch<Body = unknown> {
  readonly messages: readonly Message<Body>[];
  readonly queue: string;
  retryAll(options?: QueueRetryOptions): void;
  ackAll(): void;
}

/**
 * Message format for the ingest queue
 */
export interface IngestMessage {
  type: 'repository' | 'file';
  repoId: string;
  userId: string | null;
  provider: string;
  owner: string;
  repo: string;
  branch: string;
  path?: string;
  sha?: string;
  isPrivate: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
}

/**
 * Message format for the dead letter queue
 */
export interface DeadLetterMessage {
  originalMessage: IngestMessage;
  error: {
    message: string;
    stack?: string;
    code?: string;
  };
  attempts: number;
  lastAttemptAt: number;
}

/**
 * GitHub webhook event types
 */
export type GitHubWebhookEvent =
  | 'push'
  | 'installation'
  | 'installation_repositories'
  | 'ping';

/**
 * GitHub webhook payload for push events
 */
export interface GitHubPushEvent {
  ref: string;
  before: string;
  after: string;
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
    private: boolean;
    default_branch: string;
  };
  commits: Array<{
    id: string;
    message: string;
    timestamp: string;
    added: string[];
    removed: string[];
    modified: string[];
  }>;
  head_commit: {
    id: string;
    timestamp: string;
  };
}

/**
 * GitHub webhook payload for installation events
 */
export interface GitHubInstallationEvent {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend';
  installation: {
    id: number;
    account: {
      login: string;
      id: number;
    };
    repository_selection: 'all' | 'selected';
    permissions: Record<string, string>;
  };
  repositories?: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
  }>;
  sender: {
    id: number;
    login: string;
  };
}

/**
 * GitHub webhook payload for installation_repositories events
 */
export interface GitHubInstallationRepositoriesEvent {
  action: 'added' | 'removed';
  installation: {
    id: number;
    account: {
      login: string;
      id: number;
    };
  };
  repository_selection: 'all' | 'selected';
  repositories_added?: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
  }>;
  repositories_removed?: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
  }>;
  sender: {
    id: number;
    login: string;
  };
}

/**
 * GitHub API response for repository contents
 */
export interface GitHubContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  content?: string;
  encoding?: 'base64';
}

/**
 * GitHub API response for repository tree
 */
export interface GitHubTree {
  sha: string;
  url: string;
  tree: Array<{
    path: string;
    mode: string;
    type: 'blob' | 'tree' | 'commit';
    sha: string;
    size?: number;
    url: string;
  }>;
  truncated: boolean;
}

/**
 * GitHub API response for a commit
 */
export interface GitHubCommit {
  sha: string;
  commit: {
    author: {
      name: string;
      email: string;
      date: string;
    };
    committer: {
      name: string;
      email: string;
      date: string;
    };
    message: string;
    tree: {
      sha: string;
      url: string;
    };
    url: string;
  };
  url: string;
  html_url: string;
  parents: Array<{
    sha: string;
    url: string;
    html_url: string;
  }>;
}
