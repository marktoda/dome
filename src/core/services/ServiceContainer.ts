/**
 * Service container for dependency injection and singleton management.
 * Provides centralized access to all application services.
 */

import { NoteService } from './NoteService.js';
import { NoteSearchService } from './NoteSearchService.js';
import { NoteSummarizer } from './NoteSummarizer.js';
import { FolderContextService } from './FolderContextService.js';
import { FrontmatterService } from './FrontmatterService.js';
import { FileSystemNoteStore } from '../store/NoteStore.js';
import { config, getAIModel } from '../utils/config.js';
import type { NoteStore } from '../store/NoteStore.js';

/**
 * Service container interface defining all available services
 */
export interface IServiceContainer {
  noteStore: NoteStore;
  noteService: NoteService;
  noteSearchService: NoteSearchService;
  noteSummarizer: NoteSummarizer;
  folderContextService: FolderContextService;
  frontmatterService: FrontmatterService;
}

/**
 * Singleton service container implementation
 */
export class ServiceContainer implements IServiceContainer {
  private static instance: ServiceContainer;
  
  private _noteStore?: NoteStore;
  private _noteService?: NoteService;
  private _noteSearchService?: NoteSearchService;
  private _noteSummarizer?: NoteSummarizer;
  private _folderContextService?: FolderContextService;
  private _frontmatterService?: FrontmatterService;
  
  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {}
  
  /**
   * Get the singleton instance of the service container
   */
  static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      ServiceContainer.instance = new ServiceContainer();
    }
    return ServiceContainer.instance;
  }
  
  /**
   * Reset the container (useful for testing)
   */
  static reset(): void {
    if (ServiceContainer.instance) {
      // Clear all cached services
      ServiceContainer.instance._noteStore = undefined;
      ServiceContainer.instance._noteService = undefined;
      ServiceContainer.instance._noteSearchService = undefined;
      ServiceContainer.instance._noteSummarizer = undefined;
      ServiceContainer.instance._folderContextService = undefined;
      ServiceContainer.instance._frontmatterService = undefined;
    }
    ServiceContainer.instance = undefined as any;
  }
  
  // ============================================================================
  // Service Getters (Lazy Initialization)
  // ============================================================================
  
  /**
   * Get the note store instance
   */
  get noteStore(): NoteStore {
    if (!this._noteStore) {
      this._noteStore = new FileSystemNoteStore();
    }
    return this._noteStore;
  }
  
  /**
   * Get the note service instance
   */
  get noteService(): NoteService {
    if (!this._noteService) {
      this._noteService = new NoteService(this.noteStore);
    }
    return this._noteService;
  }
  
  /**
   * Get the note search service instance
   */
  get noteSearchService(): NoteSearchService {
    if (!this._noteSearchService) {
      this._noteSearchService = new NoteSearchService(this.noteService);
    }
    return this._noteSearchService;
  }
  
  /**
   * Get the note summarizer instance
   */
  get noteSummarizer(): NoteSummarizer {
    if (!this._noteSummarizer) {
      this._noteSummarizer = new NoteSummarizer({
        model: getAIModel('summarizer'),
        temperature: config.ai.temperature,
      });
    }
    return this._noteSummarizer;
  }
  
  /**
   * Get the folder context service instance
   */
  get folderContextService(): FolderContextService {
    if (!this._folderContextService) {
      this._folderContextService = new FolderContextService();
    }
    return this._folderContextService;
  }
  
  /**
   * Get the frontmatter service instance
   */
  get frontmatterService(): FrontmatterService {
    if (!this._frontmatterService) {
      this._frontmatterService = new FrontmatterService();
    }
    return this._frontmatterService;
  }
  
  // ============================================================================
  // Service Registration (for testing/mocking)
  // ============================================================================
  
  /**
   * Register a custom note store implementation
   */
  registerNoteStore(store: NoteStore): void {
    this._noteStore = store;
    // Reset dependent services
    this._noteService = undefined;
    this._noteSearchService = undefined;
  }
  
  /**
   * Register a custom note service implementation
   */
  registerNoteService(service: NoteService): void {
    this._noteService = service;
    // Reset dependent services
    this._noteSearchService = undefined;
  }
  
  /**
   * Register a custom note search service implementation
   */
  registerNoteSearchService(service: NoteSearchService): void {
    this._noteSearchService = service;
  }
  
  /**
   * Register a custom note summarizer implementation
   */
  registerNoteSummarizer(summarizer: NoteSummarizer): void {
    this._noteSummarizer = summarizer;
  }
  
  /**
   * Register a custom folder context service implementation
   */
  registerFolderContextService(service: FolderContextService): void {
    this._folderContextService = service;
  }
  
  /**
   * Register a custom frontmatter service implementation
   */
  registerFrontmatterService(service: FrontmatterService): void {
    this._frontmatterService = service;
  }
}

// ============================================================================
// Convenience Exports
// ============================================================================

/**
 * Get the singleton service container instance
 */
export function getServices(): IServiceContainer {
  return ServiceContainer.getInstance();
}

/**
 * Get a specific service from the container
 */
export function getService<K extends keyof IServiceContainer>(
  serviceName: K
): IServiceContainer[K] {
  return getServices()[serviceName];
}

/**
 * Decorator for injecting services into class properties
 */
export function InjectService<K extends keyof IServiceContainer>(serviceName: K) {
  return function (target: any, propertyKey: string) {
    Object.defineProperty(target, propertyKey, {
      get() {
        return getService(serviceName);
      },
      enumerable: true,
      configurable: true,
    });
  };
}

/**
 * Higher-order function for injecting services into functions
 */
export function withServices<T extends (...args: any[]) => any>(
  fn: (services: IServiceContainer, ...args: Parameters<T>) => ReturnType<T>
): T {
  return ((...args: Parameters<T>) => {
    return fn(getServices(), ...args);
  }) as T;
}

// Export singleton instance for backward compatibility
export const serviceContainer = ServiceContainer.getInstance();