export type IntegrationPlatform = 'github' | 'notion';

export interface Integration {
  platform: IntegrationPlatform;
  name: string; // e.g., "GitHub", "Notion"
  icon?: React.ReactNode; // Optional: for displaying an icon
  isConnected: boolean;
  description: string;
  connectUrl: string; // API endpoint to initiate connection
  disconnectUrl: string; // API endpoint to disconnect
  statusUrl: string; // API endpoint to get status (might not be needed per integration if global status endpoint exists)
}

export interface IntegrationStatus {
  platform: IntegrationPlatform;
  isConnected: boolean;
  user?: {
    // Optional: basic user info from the connected service
    name?: string;
    email?: string;
  };
}
