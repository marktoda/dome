/**
 * Environment bindings for the Chat service
 */
export interface Env {
  // Database binding
  DB: D1Database;

  // Service bindings
  SEARCH?: any; // Search service binding
  TODOS?: any; // Todos service binding
  AUTH?: any; // Auth service binding

  // AI binding
  AI: any;

  // Vectorize index
  VECTORIZE_INDEX: any;

  // Configuration variables
  LOG_LEVEL?: string;
  VERSION?: string;
  ENVIRONMENT?: string;
}
