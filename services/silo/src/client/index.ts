/**
 * Silo Client Exports
 *
 * This file exports the public API of the Silo service for use by other services.
 * It provides a type-safe client for interacting with the Silo service.
 */

import { SiloClient, createSiloClient } from './client';
import { SiloBinding } from '../types';

export { SiloClient, SiloBinding, createSiloClient };
export * from '../queues';
