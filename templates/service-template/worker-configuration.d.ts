// Worker environment bindings
interface Env {
  // Database bindings
  // DB: D1Database;
  
  // Vector database bindings
  // VECTORIZE: VectorizeIndex;
  
  // Queue bindings
  // EXAMPLE_QUEUE: Queue;
  
  // Service bindings
  // AUTH: Fetcher;
  // SILO: Fetcher;
  // CONSTELLATION: Fetcher;
  
  // Environment variables
  ENVIRONMENT: string;
  LOG_LEVEL?: string;
  
  // API Keys (if needed)
  // OPENAI_API_KEY?: string;
  // ANTHROPIC_API_KEY?: string;
}

// Worker context
interface Context extends ExecutionContext {
  // Additional context properties if needed
}

// Export for use in service files
export { Env, Context };