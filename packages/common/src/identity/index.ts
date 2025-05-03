/**
 * Identity Context Module
 * 
 * Provides utilities for propagating user identity across service boundaries using
 * AsyncLocalStorage and W3C Baggage format.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Represents a user's identity context with minimal required information
 * @property uid - The user's unique identifier
 * @property org - Optional organization identifier the user belongs to
 */
export interface Identity {
  uid: string;
  org?: string;
}

/**
 * AsyncLocalStorage instance for storing and retrieving identity context
 * within the scope of an async operation.
 */
export const identityContext = new AsyncLocalStorage<Identity>();

/**
 * Error thrown when identity context is accessed but not available
 */
export class MissingIdentityContextError extends Error {
  constructor() {
    super('Identity context is not available. Ensure setIdentityContext() was called or the operation is within a withIdentityContext() call');
    this.name = 'MissingIdentityContextError';
  }
}

/**
 * Gets the current identity context from AsyncLocalStorage
 * @returns The current identity context if available
 * @throws MissingIdentityContextError if no context is available
 */
export function getIdentityContext(): Identity {
  const identity = identityContext.getStore();
  if (!identity) {
    throw new MissingIdentityContextError();
  }
  return identity;
}

/**
 * Sets the identity context for the current async scope
 * @param identity The identity to set as current context
 * @param callback Function to execute within the identity context
 * @returns The result of the callback function
 */
export function setIdentityContext<T>(identity: Identity, callback: () => T | Promise<T>): T | Promise<T> {
  return identityContext.run(identity, callback);
}

/**
 * Runs a function with the provided identity context
 * @param identity The identity to use as context
 * @param fn Function to execute within the identity context
 * @returns Promise resolving to the function's result
 */
export async function withIdentityContext<T>(identity: Identity, fn: () => Promise<T>): Promise<T> {
  return identityContext.run(identity, fn);
}

/**
 * Encodes identity into W3C Baggage format for propagation between services
 * @param identity The identity to encode
 * @returns Baggage string in W3C format
 */
export function encodeIdentityAsBaggage(identity: Identity): string {
  const parts: string[] = [];
  
  // Add uid (always required)
  parts.push(`uid=${encodeURIComponent(identity.uid)}`);
  
  // Add org if present
  if (identity.org) {
    parts.push(`org=${encodeURIComponent(identity.org)}`);
  }
  
  return parts.join(',');
}

/**
 * Decodes W3C Baggage format string into an Identity object
 * @param baggage The baggage string to decode
 * @returns Decoded Identity object or undefined if invalid baggage
 */
export function decodeIdentityFromBaggage(baggage: string): Identity | undefined {
  if (!baggage) {
    return undefined;
  }
  
  const result: Partial<Identity> = {};
  const pairs = baggage.split(',');
  
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (!key || !value) continue;
    
    if (key === 'uid') {
      result.uid = decodeURIComponent(value);
    } else if (key === 'org') {
      result.org = decodeURIComponent(value);
    }
  }
  
  // Return identity only if it has the required uid field
  if (result.uid) {
    return result as Identity;
  }
  
  return undefined;
}