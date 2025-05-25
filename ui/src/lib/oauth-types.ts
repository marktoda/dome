import React from 'react';

/**
 * Defines the supported integration platforms.
 * Add new platform identifiers here as needed.
 */
export type IntegrationPlatform = 'github' | 'notion';

/**
 * Represents the static configuration and dynamic state of a single integration.
 * Used to display integration options and their current status in the UI.
 */
export interface Integration {
  /** Unique identifier for the platform (e.g., 'github'). */
  platform: IntegrationPlatform;
  /** User-friendly name of the integration (e.g., "GitHub"). */
  name: string;
  /** Optional React node representing the integration's icon. */
  icon?: React.ReactNode;
  /** Current connection status (fetched dynamically). */
  isConnected: boolean;
  /** Brief description of what the integration does. */
  description: string;
  /** Relative API endpoint URL to initiate the OAuth connection flow. */
  connectUrl: string;
  /** Relative API endpoint URL to disconnect the integration. */
  disconnectUrl: string;
  /**
   * Relative API endpoint URL to fetch the current status of this specific integration.
   * Note: May not be used if a single global endpoint fetches statuses for all integrations.
   */
  statusUrl: string;
}

/**
 * Represents the status information for a specific integration, typically fetched from the backend.
 */
export interface IntegrationStatus {
  /** The platform this status belongs to. */
  platform: IntegrationPlatform;
  /** Indicates whether the integration is currently connected for the user. */
  isConnected: boolean;
  /** Optional details about the user's account on the connected platform. */
  user?: {
    /** User's display name on the platform. */
    name?: string;
    /** User's email address associated with the platform account. */
    email?: string;
    /** Platform-specific username (e.g., GitHub handle). */
    username?: string;
    /** URL to the user's profile page on the platform. */
    profileUrl?: string;
  };
  // Could add other status details like last sync time, specific permissions granted, etc.
}
