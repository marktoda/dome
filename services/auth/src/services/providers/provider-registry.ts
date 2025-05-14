/**
 * @file Manages the registration and lookup of authentication providers.
 */
import { AuthProvider } from './base-auth-provider';

/**
 * Interface for a registry of authentication providers.
 */
export interface ProviderRegistry {
  /**
   * Registers an authentication provider.
   * @param provider - The authentication provider instance to register.
   * @throws Error if a provider with the same name is already registered.
   */
  registerProvider(provider: AuthProvider): void;

  /**
   * Retrieves an authentication provider by its name.
   * @param providerName - The name of the provider to retrieve.
   * @returns The authentication provider instance, or undefined if not found.
   */
  getProvider(providerName: string): AuthProvider | undefined;

  /**
   * Retrieves all registered authentication providers.
   * @returns An array of all registered AuthProvider instances.
   */
  getAllProviders(): AuthProvider[];

  /**
   * Checks if a provider with the given name is registered.
   * @param providerName - The name of the provider to check.
   * @returns True if the provider is registered, false otherwise.
   */
  hasProvider(providerName: string): boolean;
}

/**
 * Default implementation of the ProviderRegistry.
 */
export class DefaultProviderRegistry implements ProviderRegistry {
  private providers: Map<string, AuthProvider> = new Map();

  registerProvider(provider: AuthProvider): void {
    if (this.providers.has(provider.providerName)) {
      throw new Error(`Provider with name "${provider.providerName}" is already registered.`);
    }
    this.providers.set(provider.providerName, provider);
    console.log(`Auth provider "${provider.providerName}" registered.`);
  }

  getProvider(providerName: string): AuthProvider | undefined {
    return this.providers.get(providerName);
  }

  getAllProviders(): AuthProvider[] {
    return Array.from(this.providers.values());
  }

  hasProvider(providerName: string): boolean {
    return this.providers.has(providerName);
  }
}

// Singleton instance of the provider registry
// This makes it easy to access the registry from anywhere in the auth service.
// Ensure this is initialized appropriately in your application setup.
let globalRegistryInstance: ProviderRegistry | null = null;

/**
 * Gets the global instance of the ProviderRegistry.
 * Creates one if it doesn't exist yet.
 * @returns The singleton ProviderRegistry instance.
 */
export function getGlobalProviderRegistry(): ProviderRegistry {
  if (!globalRegistryInstance) {
    globalRegistryInstance = new DefaultProviderRegistry();
  }
  return globalRegistryInstance;
}
