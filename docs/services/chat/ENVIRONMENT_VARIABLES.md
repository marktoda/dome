# Chat Service Environment Variables

This document provides a comprehensive list of environment variables used by the Chat Service, including their purpose, default values, validation rules, and impact on service behavior.

## 1. Overview

Environment variables are used to configure the Chat Service without requiring code changes. They control various aspects of the service's behavior, including:

- Model selection and parameters
- Token limits and allocation
- Retrieval settings
- Observability configuration
- Performance tuning
- Security settings

## 2. Core Configuration Variables

### 2.1 Model Configuration

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `CHAT_MODEL` | Default LLM model to use | No | `"gpt-4o"` | Must be a supported model ID | Determines which LLM is used for response generation |
| `CHAT_TEMPERATURE` | Default temperature for LLM | No | `0.7` | Must be between 0 and 2 | Controls randomness in response generation |
| `CHAT_MAX_TOKENS` | Default maximum tokens for response | No | `1000` | Must be positive integer | Limits the length of generated responses |
| `CHAT_SYSTEM_PROMPT` | Default system prompt | No | *See below* | N/A | Sets the base system instructions for the LLM |

Default system prompt:
```
You are an AI assistant with access to the user's personal knowledge base. 
Provide helpful, accurate, and concise responses based on the provided context and your knowledge.
When referencing information from the context, include the source number in brackets, e.g., [1].
```

### 2.2 Token Management

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `MAX_CONTEXT_TOKENS` | Maximum tokens for context | No | `8000` | Must be positive integer | Limits total tokens used for context |
| `MAX_TOKENS_PER_DOC` | Maximum tokens per document | No | `1000` | Must be positive integer | Limits size of individual documents |
| `MAX_HISTORY_TOKENS` | Maximum tokens for conversation history | No | `2000` | Must be positive integer | Limits conversation history size |
| `TOKEN_SAFETY_MARGIN` | Token safety margin percentage | No | `0.1` | Must be between 0 and 1 | Reserves token capacity for unexpected expansion |

### 2.3 Retrieval Configuration

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `MIN_RELEVANCE_SCORE` | Minimum relevance score for documents | No | `0.7` | Must be between 0 and 1 | Filters out less relevant documents |
| `MAX_DOCUMENTS` | Maximum number of documents to retrieve | No | `10` | Must be positive integer | Limits number of retrieved documents |
| `ENABLE_WIDENING` | Enable search widening | No | `true` | Must be boolean | Controls whether search widening is enabled |
| `MAX_WIDENING_ATTEMPTS` | Maximum widening attempts | No | `2` | Must be non-negative integer | Limits number of widening attempts |
| `WIDENING_DECAY_FACTOR` | Relevance decay factor for widening | No | `0.1` | Must be between 0 and 1 | Controls how much relevance threshold is reduced per widening |

## 3. Service Integration Variables

### 3.1 Service Bindings

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `VECTORIZE_BINDING` | Name of Vectorize binding | Yes | N/A | Must be valid binding name | Connects to vector database for retrieval |
| `D1_BINDING` | Name of D1 database binding | Yes | N/A | Must be valid binding name | Connects to D1 for checkpointing |
| `LLM_SERVICE_BINDING` | Name of LLM service binding | No | `"LLM_SERVICE"` | Must be valid binding name | Connects to LLM service |
| `SEARCH_SERVICE_BINDING` | Name of search service binding | No | `"SEARCH_SERVICE"` | Must be valid binding name | Connects to search service |

### 3.2 External Service Configuration

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `LLM_API_KEY` | API key for external LLM provider | No | N/A | Must be valid API key | Authenticates with external LLM provider |
| `LLM_API_URL` | URL for external LLM provider | No | N/A | Must be valid URL | Connects to external LLM provider |
| `LLM_API_VERSION` | API version for external LLM provider | No | N/A | Must be valid version string | Specifies API version for external LLM provider |
| `LLM_TIMEOUT_MS` | Timeout for LLM requests in milliseconds | No | `30000` | Must be positive integer | Limits time waiting for LLM response |

## 4. Observability Variables

### 4.1 Logging Configuration

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `LOG_LEVEL` | Minimum log level to record | No | `"info"` | Must be one of: error, warn, info, debug, trace | Controls verbosity of logging |
| `ENABLE_STRUCTURED_LOGGING` | Enable structured JSON logging | No | `true` | Must be boolean | Controls log format |
| `LOG_SAMPLE_RATE` | Fraction of requests to log at debug level | No | `0.1` | Must be between 0 and 1 | Controls sampling of detailed logs |
| `REDACT_SENSITIVE_DATA` | Redact sensitive data in logs | No | `true` | Must be boolean | Controls whether sensitive data is redacted |

### 4.2 Metrics Configuration

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `ENABLE_METRICS` | Enable metrics collection | No | `true` | Must be boolean | Controls whether metrics are collected |
| `METRICS_NAMESPACE` | Namespace for metrics | No | `"chat"` | Must be valid string | Prefixes all metric names |
| `METRICS_SAMPLE_RATE` | Fraction of requests to collect metrics for | No | `1.0` | Must be between 0 and 1 | Controls sampling of metrics |

### 4.3 Tracing Configuration

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `ENABLE_TRACING` | Enable distributed tracing | No | `false` | Must be boolean | Controls whether tracing is enabled |
| `TRACE_SAMPLE_RATE` | Fraction of requests to trace | No | `0.1` | Must be between 0 and 1 | Controls sampling of traces |
| `TRACE_EXPORT_URL` | URL to export traces to | No | N/A | Must be valid URL | Destination for trace export |

## 5. Performance Variables

### 5.1 Caching Configuration

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `ENABLE_CHECKPOINT_CACHING` | Enable checkpoint caching | No | `true` | Must be boolean | Controls whether checkpoints are cached |
| `CHECKPOINT_TTL_SECONDS` | Time-to-live for checkpoints in seconds | No | `3600` | Must be positive integer | Controls how long checkpoints are retained |
| `ENABLE_RESPONSE_CACHING` | Enable response caching | No | `false` | Must be boolean | Controls whether responses are cached |
| `RESPONSE_CACHE_TTL_SECONDS` | Time-to-live for cached responses in seconds | No | `300` | Must be positive integer | Controls how long responses are cached |

### 5.2 Concurrency Configuration

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `MAX_CONCURRENT_REQUESTS` | Maximum concurrent requests | No | `50` | Must be positive integer | Limits concurrent request processing |
| `ENABLE_RATE_LIMITING` | Enable rate limiting | No | `true` | Must be boolean | Controls whether rate limiting is applied |
| `RATE_LIMIT_REQUESTS` | Maximum requests per minute per user | No | `60` | Must be positive integer | Limits request rate per user |

## 6. Security Variables

### 6.1 Authentication Configuration

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `REQUIRE_USER_ID` | Require user ID for all requests | No | `true` | Must be boolean | Controls whether user ID is required |
| `VALIDATE_USER_ID` | Validate user ID format | No | `true` | Must be boolean | Controls whether user ID format is validated |
| `USER_ID_PATTERN` | Regex pattern for valid user IDs | No | `"^[a-zA-Z0-9_-]{3,64}$"` | Must be valid regex | Defines valid user ID format |

### 6.2 Data Retention Configuration

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `DEFAULT_DATA_RETENTION_DAYS` | Default data retention period in days | No | `90` | Must be positive integer | Controls default data retention period |
| `MAX_DATA_RETENTION_DAYS` | Maximum data retention period in days | No | `365` | Must be positive integer | Limits maximum data retention period |
| `ENABLE_DATA_DELETION` | Enable data deletion | No | `true` | Must be boolean | Controls whether data deletion is enabled |

## 7. Feature Flag Variables

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `ENABLE_STREAMING` | Enable streaming responses | No | `true` | Must be boolean | Controls whether streaming is enabled |
| `ENABLE_TOOL_EXECUTION` | Enable tool execution | No | `true` | Must be boolean | Controls whether tools can be executed |
| `ENABLE_QUERY_REWRITING` | Enable query rewriting | No | `true` | Must be boolean | Controls whether queries are rewritten |
| `ENABLE_SOURCE_ATTRIBUTION` | Enable source attribution | No | `true` | Must be boolean | Controls whether sources are included in responses |

## 8. Environment-Specific Variables

### 8.1 Development Environment

In development environments, these additional variables may be useful:

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `MOCK_LLM_RESPONSES` | Use mock LLM responses | No | `false` | Must be boolean | Controls whether LLM calls are mocked |
| `MOCK_SEARCH_RESULTS` | Use mock search results | No | `false` | Must be boolean | Controls whether search is mocked |
| `DEVELOPMENT_USER_ID` | Default user ID for development | No | `"dev-user"` | Must be valid user ID | Sets default user ID for development |
| `VERBOSE_LOGGING` | Enable verbose logging | No | `true` | Must be boolean | Increases log verbosity for development |

### 8.2 Testing Environment

In testing environments, these additional variables may be useful:

| Variable | Description | Required | Default | Validation | Impact |
|----------|-------------|----------|---------|------------|--------|
| `TEST_MODE` | Enable test mode | No | `false` | Must be boolean | Enables test-specific behavior |
| `DETERMINISTIC_RESPONSES` | Use deterministic responses | No | `true` | Must be boolean | Makes responses deterministic for testing |
| `SKIP_EXTERNAL_CALLS` | Skip external service calls | No | `true` | Must be boolean | Prevents calls to external services |
| `TEST_TIMEOUT_MS` | Timeout for tests in milliseconds | No | `5000` | Must be positive integer | Limits test execution time |

## 9. Setting Environment Variables

### 9.1 Using wrangler.toml

Environment variables can be set in the `wrangler.toml` file:

```toml
[vars]
CHAT_MODEL = "gpt-4o"
MAX_CONTEXT_TOKENS = "8000"
ENABLE_TRACING = "false"
```

### 9.2 Using .dev.vars for Local Development

For local development, create a `.dev.vars` file:

```
CHAT_MODEL=gpt-4o
MAX_CONTEXT_TOKENS=8000
ENABLE_TRACING=false
```

### 9.3 Using Cloudflare Dashboard

For production environments, set environment variables in the Cloudflare Dashboard:

1. Navigate to Workers & Pages
2. Select the Chat Service worker
3. Go to Settings > Variables
4. Add or update environment variables

### 9.4 Using Wrangler CLI

Environment variables can also be set using the Wrangler CLI:

```bash
wrangler secret put CHAT_MODEL
# Enter the value when prompted
```

## 10. Environment Variable Validation

The Chat Service validates environment variables at startup:

```typescript
function validateEnvironment(env: Env): void {
  // Required bindings
  if (!env.DB) {
    throw new Error('Missing required DB binding');
  }
  
  if (!env.VECTORIZE) {
    throw new Error('Missing required VECTORIZE binding');
  }
  
  // Validate numeric values
  const maxContextTokens = parseInt(env.MAX_CONTEXT_TOKENS || '8000', 10);
  if (isNaN(maxContextTokens) || maxContextTokens <= 0) {
    throw new Error('MAX_CONTEXT_TOKENS must be a positive integer');
  }
  
  // Validate ranges
  const minRelevanceScore = parseFloat(env.MIN_RELEVANCE_SCORE || '0.7');
  if (isNaN(minRelevanceScore) || minRelevanceScore < 0 || minRelevanceScore > 1) {
    throw new Error('MIN_RELEVANCE_SCORE must be between 0 and 1');
  }
  
  // Log configuration
  console.log('Environment validated successfully');
}
```

## 11. Best Practices

### 11.1 Environment Variable Usage

When using environment variables in the Chat Service:

1. **Provide Defaults**: Always provide sensible defaults for optional variables
2. **Validate Early**: Validate environment variables at service startup
3. **Type Conversion**: Convert string environment variables to appropriate types
4. **Documentation**: Keep this documentation updated when adding new variables
5. **Security**: Never log sensitive environment variables

### 11.2 Environment Variable Naming

Follow these naming conventions for environment variables:

1. **Use UPPER_SNAKE_CASE**: All environment variables should use uppercase with underscores
2. **Use Prefixes**: Group related variables with common prefixes
3. **Be Descriptive**: Use descriptive names that indicate purpose
4. **Avoid Abbreviations**: Use full words rather than abbreviations
5. **Indicate Types**: Use suffixes like `_MS`, `_SECONDS`, or `_ENABLED` to indicate types