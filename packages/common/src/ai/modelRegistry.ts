/**
 * LLM Model Registry
 *
 * Provides a central registry for all LLM models in the system.
 * The registry allows services to:
 * - Register models from different providers
 * - Retrieve models by key or ID
 * - Get all models from a specific provider
 * - Configure the default model
 */

import { getLogger } from '../context/index.js';
import { BaseModelConfig, ModelProvider, isModelConfig } from './types.js';

export class ModelRegistry {
  /** Map of model key to model config */
  private modelsByKey = new Map<string, BaseModelConfig>();

  /** Map of model ID to model config */
  private modelsById = new Map<string, BaseModelConfig>();

  /** Default model configuration */
  private defaultModel: BaseModelConfig | null = null;

  /** Logger instance */
  private logger = getLogger().child({ component: 'ModelRegistry' });

  /**
   * Create a new model registry
   * @param initialModels Optional array of initial models to register
   */
  constructor(initialModels?: BaseModelConfig[]) {
    if (initialModels) {
      this.registerMany(initialModels);
    }
  }

  /**
   * Register a single model in the registry
   * @param model Model configuration
   * @returns this (for chaining)
   * @throws Error if the model key or ID is already registered
   */
  register(model: BaseModelConfig): this {
    // Validate model config
    if (!isModelConfig(model)) {
      throw new Error(`Invalid model configuration: ${JSON.stringify(model)}`);
    }

    // Check for duplicate key
    if (this.modelsByKey.has(model.key)) {
      throw new Error(`Model with key "${model.key}" is already registered`);
    }

    // Check for duplicate ID
    if (this.modelsById.has(model.id)) {
      throw new Error(`Model with ID "${model.id}" is already registered`);
    }

    // Register the model
    this.modelsByKey.set(model.key, model);
    this.modelsById.set(model.id, model);

    // If this is the first model, set it as default
    if (!this.defaultModel) {
      this.defaultModel = model;
    }

    this.logger.debug({ model: model.key }, 'Registered model');
    return this;
  }

  /**
   * Register multiple models at once
   * @param models Array of model configurations
   * @returns this (for chaining)
   */
  registerMany(models: BaseModelConfig[]): this {
    for (const model of models) {
      this.register(model);
    }
    return this;
  }

  /**
   * Get a model by its key
   * @param key Model key
   * @returns Model configuration or undefined if not found
   */
  getByKey(key: string): BaseModelConfig | undefined {
    return this.modelsByKey.get(key);
  }

  /**
   * Get a model by its ID
   * @param id Model ID
   * @returns Model configuration or undefined if not found
   */
  getById(id: string): BaseModelConfig | undefined {
    return this.modelsById.get(id);
  }

  /**
   * Get all models from a specific provider
   * @param provider Provider to filter by
   * @returns Array of model configurations
   */
  getByProvider(provider: ModelProvider): BaseModelConfig[] {
    return Array.from(this.modelsByKey.values()).filter(model => model.provider === provider);
  }

  /**
   * Get all registered models
   * @param productionOnly Only include production-ready models if true
   * @returns Array of all registered model configurations
   */
  getAll(productionOnly = false): BaseModelConfig[] {
    const allModels = Array.from(this.modelsByKey.values());
    return productionOnly ? allModels.filter(model => model.productionReady) : allModels;
  }

  /**
   * Set the default model
   * @param keyOrId Model key or ID
   * @returns this (for chaining)
   * @throws Error if model not found
   */
  setDefaultModel(keyOrId: string): this {
    // Try to find the model by key first, then by ID
    let model = this.getByKey(keyOrId) || this.getById(keyOrId);

    if (!model) {
      throw new Error(`Model with key or ID "${keyOrId}" not found`);
    }

    this.defaultModel = model;
    this.logger.info({ model: model.key }, 'Set default model');
    return this;
  }

  /**
   * Get the default model
   * @returns Default model configuration
   * @throws Error if no default model is set
   */
  getDefaultModel(): BaseModelConfig {
    if (!this.defaultModel) {
      throw new Error('No default model configured');
    }

    return this.defaultModel;
  }

  /**
   * Get a model by key or ID, or fallback to default model
   * @param keyOrId Model key or ID
   * @returns Model configuration
   */
  getModel(keyOrId?: string): BaseModelConfig {
    if (!keyOrId) {
      return this.getDefaultModel();
    }

    // Try to find the model by key first, then by ID
    const model = this.getByKey(keyOrId) || this.getById(keyOrId);

    // Return found model or default
    return model || this.getDefaultModel();
  }

  /**
   * Check if a model is registered
   * @param keyOrId Model key or ID
   * @returns true if model is registered, false otherwise
   */
  hasModel(keyOrId: string): boolean {
    return this.modelsByKey.has(keyOrId) || this.modelsById.has(keyOrId);
  }

  /**
   * Remove all models from the registry
   * @returns this (for chaining)
   */
  clear(): this {
    this.modelsByKey.clear();
    this.modelsById.clear();
    this.defaultModel = null;
    return this;
  }
}
