import { getLogger } from '@dome/common';
import { ServiceErrors } from '../utils/errors';
import type { {{SERVICE_NAME}}ClientOptions, {{SERVICE_NAME}}Response } from './types';

const logger = getLogger().child({ component: '{{SERVICE_NAME}}Client' });

/**
 * Client for interacting with the {{SERVICE_NAME}} service
 */
export class {{SERVICE_NAME}}Client {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: {{SERVICE_NAME}}ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = options.apiKey;
  }

  /**
   * Example method - replace with actual service methods
   */
  async example(): Promise<{{SERVICE_NAME}}Response> {
    try {
      logger.info('Making example request');

      const response = await fetch(`${this.baseUrl}/api/{{SERVICE_NAME}}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }),
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw ServiceErrors.ProcessingError(
          `Request failed: ${response.status}`,
          { status: response.status, ...errorData }
        );
      }

      const data = await response.json();
      logger.info('Example request completed');
      
      return data;
    } catch (error) {
      logger.error('Example request failed', { error });
      
      if (error instanceof Error && 'status' in error) {
        throw error; // Already a service error
      }
      
      throw ServiceErrors.ProcessingError(
        'Failed to process request',
        { originalError: error }
      );
    }
  }

  /**
   * Health check method
   */
  async healthCheck(): Promise<{ status: string; service: string; timestamp: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      
      if (!response.ok) {
        throw ServiceErrors.ProcessingError(
          `Health check failed: ${response.status}`
        );
      }

      return await response.json();
    } catch (error) {
      logger.error('Health check failed', { error });
      throw ServiceErrors.ProcessingError('Service health check failed');
    }
  }
}