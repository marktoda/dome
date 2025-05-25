import { nanoid } from 'nanoid';
import { StateData } from '../types.js';

export interface StateStorage {
  store(state: string, data: StateData): Promise<void>;
  retrieve(state: string): Promise<StateData | null>;
  remove(state: string): Promise<void>;
}

export class MemoryStateStorage implements StateStorage {
  private storage = new Map<string, StateData>();

  async store(state: string, data: StateData): Promise<void> {
    this.storage.set(state, data);
    
    // Auto-cleanup expired states
    setTimeout(() => {
      const storedData = this.storage.get(state);
      if (storedData && Date.now() > storedData.expiresAt) {
        this.storage.delete(state);
      }
    }, data.expiresAt - Date.now());
  }

  async retrieve(state: string): Promise<StateData | null> {
    const data = this.storage.get(state);
    if (!data) {
      return null;
    }

    // Check if expired
    if (Date.now() > data.expiresAt) {
      this.storage.delete(state);
      return null;
    }

    return data;
  }

  async remove(state: string): Promise<void> {
    this.storage.delete(state);
  }
}

export class StateManager {
  private static instance: StateManager;
  private storage: StateStorage;

  constructor(storage: StateStorage = new MemoryStateStorage()) {
    this.storage = storage;
  }

  static getInstance(storage?: StateStorage): StateManager {
    if (!StateManager.instance) {
      StateManager.instance = new StateManager(storage);
    }
    return StateManager.instance;
  }

  async generateState(
    redirectPath?: string,
    additionalData?: Record<string, string>,
    ttlMinutes: number = 5
  ): Promise<string> {
    const state = nanoid(32);
    const expiresAt = Date.now() + (ttlMinutes * 60 * 1000);

    const stateData: StateData = {
      state,
      redirectPath,
      additionalData,
      expiresAt,
    };

    await this.storage.store(state, stateData);
    return state;
  }

  async validateState(state: string): Promise<StateData | null> {
    if (!state) {
      return null;
    }

    const stateData = await this.storage.retrieve(state);
    if (!stateData) {
      return null;
    }

    // Remove state after successful validation (one-time use)
    await this.storage.remove(state);
    return stateData;
  }

  async cleanExpiredStates(): Promise<void> {
    // This is primarily for storage implementations that don't auto-cleanup
    // The default MemoryStateStorage handles this automatically
  }
}