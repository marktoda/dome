/**
 * Environment interface for the chat orchestrator
 */
export interface Env {
  // Database bindings
  CHAT_DB: any; // Required property
  D1?: any; // Added for tests
  
  // Service bindings
  CHAT_ORCHESTRATOR?: any;
  AI?: any;
  
  // Configuration
  ENCRYPTION_KEY?: string;
  DOME_API_URL?: string;
  DOME_API_KEY?: string;
  VERSION: "0.1.0"; // Using literal type to match existing code
  
  // Environment settings
  LOG_LEVEL: any; // Using any to be compatible with all uses
  ENVIRONMENT: any; // Using any to be compatible with all uses
}