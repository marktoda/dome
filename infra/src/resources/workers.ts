// Chat Orchestrator Worker
workers.chatOrchestrator = createWorker(
  {
    name: 'chat-orchestrator',
    mainModule: 'services/chat-orchestrator/src/index.ts',
    compatibilityDate: '2025-04-15',
    compatibilityFlags: ['nodejs_als'],
    bindings: [
      { type: 'ai', name: 'AI' },
      { type: 'd1Database', name: 'D1', databaseId: 'chatOrchestrator' },
      { type: 'service', name: 'DOME_API', service: 'dome-api' },
      { type: 'service', name: 'CONSTELLATION', service: 'constellation' },
    ],
    vars: {
      VERSION: '0.1.0',
      LOG_LEVEL: 'debug',
      DOME_API_URL: 'https://api.dome.cloud',
      DOME_API_KEY: 'placeholder-key', // Will be replaced in environment-specific configs
      ENABLE_DYNAMIC_WIDENING: 'true',
      ENABLE_TOOL_REGISTRY: 'true',
      ENABLE_ADVANCED_RETRIEVAL: 'true',
      ENABLE_CACHING: 'true',
      ENABLE_PARALLEL_PROCESSING: 'false', // Disabled by default
    },
  },
  d1Databases,
  r2Buckets,
  vectorizeIndexes,
  queues,
);

// Ingestion Manager Worker
