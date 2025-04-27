# LLM Model Configuration

This document describes how LLM models are configured in the Chat service.

## Overview

The Chat service uses a centralized model configuration system that supports multiple model providers (OpenAI, Cloudflare, Anthropic). Model configurations are defined in `src/config/modelConfig.ts` and are used consistently throughout the service.

## Configuration Structure

The model configuration includes:

- **Model interface definition** (`ModelConfig`): Defines the properties each model configuration must have
- **Provider grouping**: Models are organized by provider (OpenAI, Cloudflare, Anthropic)
- **Capability flags**: Models define capabilities like streaming support, function calling, vision
- **Environment-based selection**: Default model can be configured per environment
- **Helper functions**: Utilities for model selection and token calculation

## Available Models

| Model ID | Provider | Context Window | Description |
|----------|----------|----------------|-------------|
| GPT_4_TURBO | OpenAI | 128K tokens | High-capability model with large context window |
| GPT_3_5_TURBO | OpenAI | 16K tokens | Cost-effective model with moderate capabilities |
| LLAMA_3_70B | Cloudflare | 24K tokens | High-performance Llama model on Cloudflare |
| LLAMA_3_8B | Cloudflare | 16K tokens | Cost-effective Llama model on Cloudflare |
| CLAUDE_3_OPUS | Anthropic | 200K tokens | Highest-capability Claude model (future support) |
| CLAUDE_3_SONNET | Anthropic | 200K tokens | Mid-range Claude model (future support) |

## Environment Configuration

The default model is configured through the `DEFAULT_MODEL_ID` environment variable, which is set in the `wrangler.toml` file. Different environments use different default models:

- **Production**: GPT_4_TURBO (highest quality)
- **Staging**: GPT_3_5_TURBO (balance of cost and quality)
- **Development**: LLAMA_3_8B (cost-effective for development)

## Usage Examples

### Getting Model Configuration

```typescript
import { getModelConfig, DEFAULT_MODEL } from '../config';

// Get default model configuration
const defaultModel = DEFAULT_MODEL;

// Get model by ID
const model = getModelConfig('gpt-4-turbo');

// Calculate token limits
const { maxResponseTokens } = calculateTokenLimits(
  model,
  inputTokens,
  requestedMaxTokens
);
```

### Using the Model Factory

The `ModelFactory` provides a centralized way to create properly configured model instances for LangGraph nodes and other components:

```typescript
import { ModelFactory } from '../services/modelFactory';

// Create a model using the default configuration
const model = ModelFactory.createChatModel(env);

// Create a model with specific options
const customModel = ModelFactory.createChatModel(env, {
  modelId: 'gpt-4-turbo',
  temperature: 0.8,
  maxTokens: 2000,
  streaming: true
});
```

The factory automatically handles:
- Model provider selection (OpenAI, Cloudflare, Anthropic)
- Configuration based on the model's capabilities
- Environment-specific settings
- Fallbacks for unavailable models or capabilities

### Specifying a Model in Requests

Users can specify a model in their chat requests:

```typescript
const request = {
  userId: 'user123',
  messages: [...],
  options: {
    // Override default model with a specific model ID
    modelId: 'gpt-3.5-turbo',
    // Other options...
    maxTokens: 1000,
    temperature: 0.7
  }
};
```

## Adding New Models

To add a new model:

1. Update the `MODELS` object in `src/config/modelConfig.ts`
2. Add the model under the appropriate provider section
3. Define all required properties (id, name, context window size, etc.)
4. Set `productionReady: true` when the model is ready for production use

## Future Improvements

- Add support for Anthropic models
- Enhance provider-specific client implementations
- Add cost tracking and optimization options
- Support for fine-tuned models
- Implement caching for frequently used responses
- Add runtime performance metrics collection