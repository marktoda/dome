# LLM Configuration System

This module provides a centralized system for managing LLM model configurations and context allocation across different services in the application.

## Overview

The LLM Configuration System solves several problems:

1. **Centralized Model Configuration**: Single source of truth for all LLM model parameters
2. **Provider Abstraction**: Common interface for models from different providers (OpenAI, Anthropic, Cloudflare)
3. **Context Window Management**: Utilities for allocating tokens within model context windows
4. **Token Counting**: Consistent token counting across different models

## Core Components

- **Model Registry**: Central repository of all model configurations
- **Context Allocation**: Utilities for managing token allocations
- **Tokenizer**: Tools for counting tokens across different models
- **Provider Configurations**: Pre-configured models for supported providers

## Usage

### Initialization

The system auto-initializes with all predefined models, but you should configure it with environment variables in your service startup:

```typescript
import { configureLlmSystem } from '@dome/common';

// In your service initialization
export function initializeService(env: Env) {
  // Configure LLM models with environment variables
  configureLlmSystem(env);
  
  // Rest of your service initialization
}
```

### Getting Model Configurations

```typescript
import { getModelConfig, getDefaultModel, getAllModels } from '@dome/common';

// Get the default model
const defaultModel = getDefaultModel();

// Get a specific model by key or ID
const gpt4 = getModelConfig('GPT_4');
// OR
const gpt4ById = getModelConfig('gpt-4');

// Get all models (optionally filtered to production-ready)
const allModels = getAllModels();
const prodModels = getAllModels(true);
```

### Token Allocation

```typescript
import { 
  calculateContextLimits,
  calculateTokenLimits,
  calculateResponseTokens,
  countTokens,
  countMessagesTokens
} from '@dome/common';

// Calculate allocation for different components based on model
const limits = calculateContextLimits('gpt-4');
// Returns: { maxContextTokens, maxResponseTokens, maxSystemPromptTokens, maxUserMessagesTokens, maxDocumentsTokens }

// Count tokens in text for a specific model
const tokenCount = countTokens('Hello, world!', 'gpt-4');

// Count tokens in a messages array
const messages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello!' }
];
const messageTokens = countMessagesTokens(messages, 'gpt-4');

// Calculate response tokens based on input size
const inputTokens = 1000;
const maxResponseTokens = calculateResponseTokens('gpt-4', inputTokens);
```

### Usage in Chat Service

```typescript
import { 
  getModelConfig, 
  calculateTokenLimits, 
  countMessagesTokens 
} from '@dome/common';

function createChatCompletion(messages: Message[], modelId?: string) {
  // Get model configuration
  const modelConfig = getModelConfig(modelId);
  
  // Count tokens in messages
  const inputTokens = countMessagesTokens(messages, modelConfig.id);
  
  // Calculate token limits based on input
  const { maxResponseTokens } = calculateTokenLimits(
    modelConfig,
    inputTokens
  );
  
  // Make API call with calculated limits
  return callLlmApi({
    model: modelConfig.id,
    messages,
    max_tokens: maxResponseTokens,
    // Other parameters...
  });
}
```

### Usage in Embedding Service

```typescript
import { getModelConfig } from '@dome/common';

function createEmbeddings(texts: string[], modelId?: string) {
  // Get model configuration, ensuring it supports embeddings
  const modelConfig = getModelConfig(modelId || 'E5_LARGE_V2');
  
  if (!modelConfig.capabilities.embeddings) {
    throw new Error(`Model ${modelConfig.id} does not support embeddings`);
  }
  
  // Call embedding API with model ID
  return callEmbeddingApi({
    model: modelConfig.id,
    texts
  });
}
```

## Extending the System

### Adding New Models

To add new models to the registry:

```typescript
import { modelRegistry, BaseModelConfig, ModelProvider } from '@dome/common';

// Define your custom model
const customModel: BaseModelConfig = {
  key: 'MY_CUSTOM_MODEL',
  id: 'my-custom-model',
  name: 'My Custom Model',
  provider: ModelProvider.CUSTOM,
  maxContextTokens: 16000,
  defaultMaxTokens: 1024,
  defaultTemperature: 0.7,
  capabilities: {
    streaming: true,
    functionCalling: true,
    toolUse: true,
    structuredOutput: true,
    vision: false,
    embeddings: false,
  },
  productionReady: true,
};

// Register the model
modelRegistry.register(customModel);
```

## Best Practices

1. **Always use `getModelConfig()`** instead of hardcoding model IDs or parameters
2. **Calculate token limits dynamically** using the provided utilities
3. **Configure the system at service startup** with environment variables
4. **Count tokens accurately** using the provided tokenization utilities
5. **Check model capabilities** before using specific features like function calling or vision

## Implementation Notes

- The system is designed to be lightweight and flexible
- Token counting uses tiktoken for OpenAI models when available, with fallback estimation
- Context allocation is configurable per service or request
- The system initializes with a default model (usually GPT-4 Turbo), but this can be overridden

By following these patterns, your services will have consistent LLM behavior and configuration across the entire application.