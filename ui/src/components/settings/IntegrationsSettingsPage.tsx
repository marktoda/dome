"use client";

import React, { useState, useEffect, useCallback } from 'react';
import type { IntegrationStatus, Integration, IntegrationPlatform } from '@/lib/oauth-types';
import IntegrationCard from './IntegrationCard';
import { Github, BookText, RefreshCw, ZapOff } from 'lucide-react'; // Added ZapOff, Using BookText for Notion
import { Skeleton } from '@/components/ui/skeleton';
import { toast as sonnerToast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';

/**
 * Configuration for available integrations.
 * Each object defines the properties of an integration platform like GitHub or Notion.
 * `statusUrl` is generally not used per integration if a global status endpoint exists.
 */
const AVAILABLE_INTEGRATIONS_CONFIG: Omit<Integration, 'isConnected'>[] = [
  {
    platform: 'github',
    name: 'GitHub',
    icon: <Github />,
    description: 'Connect your GitHub account to sync repositories, issues, and pull requests.',
    connectUrl: '/api/settings/integrations/github/connect',
    disconnectUrl: '/api/settings/integrations/github/disconnect',
    statusUrl: '', // Not used per integration if global status endpoint exists
  },
  {
    platform: 'notion',
    name: 'Notion',
    icon: <BookText />,
    description: 'Connect your Notion account to sync pages, databases, and notes.',
    connectUrl: '/api/settings/integrations/notion/connect',
    disconnectUrl: '/api/settings/integrations/notion/disconnect',
    statusUrl: '',
  },
];

/**
 * `IntegrationsSettingsPage` provides a UI for users to manage their third-party integrations.
 * It lists available integrations, shows their current connection status, and allows users
 * to connect or disconnect them.
 *
 * Features:
 * - Fetches and displays the status of all configured integrations.
 * - Handles the OAuth flow initiation for connecting new integrations.
 * - Manages disconnection requests.
 * - Provides loading states for global status fetching and individual connect/disconnect operations.
 * - Uses `sonner` for toast notifications.
 * - Handles OAuth callback parameters in the URL to finalize connection and refresh status.
 *
 * @returns A React functional component representing the integrations settings page.
 */
const IntegrationsSettingsPage: React.FC = () => {
  /** Stores the current status of each integration platform (e.g., GitHub, Notion). */
  const [integrationStatuses, setIntegrationStatuses] = useState<Record<IntegrationPlatform, IntegrationStatus | undefined>>({
    github: undefined,
    notion: undefined,
  });

  /** Global loading state, true when initially fetching all integration statuses. */
  const [loadingGlobal, setLoadingGlobal] = useState<boolean>(true);

  /**
   * Stores the operational state (connecting/disconnecting) for each integration platform.
   * Helps manage loading indicators on individual {@link IntegrationCard} components.
   */
  const [operationStates, setOperationStates] = useState<Record<IntegrationPlatform, {isConnecting?: boolean, isDisconnecting?: boolean}>>({
    github: {},
    notion: {},
  });

  /**
   * Fetches the status for all available integrations from the backend.
   * Updates `integrationStatuses` and manages `loadingGlobal` state.
   * @param showLoadingIndicator - If true, sets `loadingGlobal` during the fetch. Defaults to true.
   */
  const fetchAllIntegrationStatuses = useCallback(async (showLoadingIndicator = true) => {
    if (showLoadingIndicator) {
        setLoadingGlobal(true);
    }
    try {
      const response = await fetch('/api/settings/integrations');
      if (!response.ok) {
        throw new Error(`Failed to fetch integration statuses: ${response.statusText}`);
      }
      const data: IntegrationStatus[] = await response.json();
      const newStatuses: Record<IntegrationPlatform, IntegrationStatus | undefined> = { github: undefined, notion: undefined };
      data.forEach(status => {
        if (newStatuses.hasOwnProperty(status.platform)) { // Ensure platform is known
           newStatuses[status.platform] = status;
        }
      });
      setIntegrationStatuses(newStatuses);
    } catch (error) {
      console.error("Error fetching integration statuses:", error);
      sonnerToast.error("Error Loading Integrations", {
        description: "Could not load integration statuses. Please try refreshing.",
      });
    } finally {
      if (showLoadingIndicator) {
        setLoadingGlobal(false);
      }
    }
  }, []);

  /** Effect to fetch all integration statuses on component mount. */
  useEffect(() => {
    fetchAllIntegrationStatuses();
  }, [fetchAllIntegrationStatuses]);

  /**
   * Initiates the connection process for a given integration platform.
   * Sets the connecting state for the platform and redirects the user to the OAuth connect URL.
   * Includes a `redirect_uri` parameter to return the user to this page after OAuth.
   * @param platform - The platform to connect (e.g., 'github', 'notion').
   */
  const handleConnect = (platform: IntegrationPlatform) => {
    setOperationStates(prev => ({ ...prev, [platform]: { isConnecting: true, isDisconnecting: false }}));
    const connectUrl = AVAILABLE_INTEGRATIONS_CONFIG.find(i => i.platform === platform)?.connectUrl;
    if (connectUrl) {
      const redirectUri = encodeURIComponent(`${window.location.origin}/settings/integrations?oauth_callback=true&platform=${platform}`);
      window.location.href = `${connectUrl}?redirect_uri=${redirectUri}`;
    } else {
      sonnerToast.error("Connection Error", { description: `Connect URL not found for ${platform}.` });
      setOperationStates(prev => ({ ...prev, [platform]: { isConnecting: false }}));
    }
  };

  /**
   * Initiates the disconnection process for a given integration platform.
   * Sets the disconnecting state, calls the backend disconnect API, shows a toast notification,
   * and refreshes integration statuses upon success or failure.
   * @param platform - The platform to disconnect.
   */
  const handleDisconnect = async (platform: IntegrationPlatform) => {
    setOperationStates(prev => ({ ...prev, [platform]: { isDisconnecting: true, isConnecting: false }}));
    try {
      const integrationConfig = AVAILABLE_INTEGRATIONS_CONFIG.find(i => i.platform === platform);
      if (!integrationConfig) throw new Error(`Invalid integration platform: ${platform}`);

      const response = await fetch(integrationConfig.disconnectUrl, { method: 'POST' });
      // It's good practice to check if response.json() is callable, e.g. by checking content-type
      const responseData = await response.json().catch(() => ({ success: false, message: 'Invalid JSON response from server.' }));

      if (!response.ok || !responseData.success) {
        throw new Error(responseData.message || `Failed to disconnect ${integrationConfig.name}.`);
      }
      sonnerToast.success("Disconnected", {
        description: `${integrationConfig.name} disconnected successfully.`,
      });
      await fetchAllIntegrationStatuses(false); // Refresh statuses without global loading indicator
    } catch (error) {
      console.error(`Error disconnecting ${platform}:`, error);
      const integrationConfig = AVAILABLE_INTEGRATIONS_CONFIG.find(i => i.platform === platform);
      sonnerToast.error("Disconnection Error", {
        description: `Could not disconnect ${integrationConfig?.name || platform}. ${(error as Error).message}`,
      });
    } finally {
      setOperationStates(prev => ({ ...prev, [platform]: { isDisconnecting: false }}));
    }
  };
  
  /**
   * Effect to handle OAuth callback parameters in the URL.
   * If `oauth_callback=true` is present, it means the user is returning from an OAuth flow.
   * It shows a success toast, refreshes integration statuses, and cleans the URL.
   * Also resets the `isConnecting` state for the specific platform.
   */
  useEffect(() => {
    const queryParams = new URLSearchParams(window.location.search);
    if (queryParams.get('oauth_callback') === 'true') {
      const platform = queryParams.get('platform') as IntegrationPlatform | null;
      const errorParam = queryParams.get('error');
      const errorDescriptionParam = queryParams.get('error_description');

      if (platform) {
        if (errorParam) {
          sonnerToast.error("Connection Failed", {
            description: `${AVAILABLE_INTEGRATIONS_CONFIG.find(i => i.platform === platform)?.name || platform} connection failed: ${errorDescriptionParam || errorParam}`,
          });
        } else {
          sonnerToast.success("Connected!", {
            description: `${AVAILABLE_INTEGRATIONS_CONFIG.find(i => i.platform === platform)?.name || platform} connected successfully.`,
          });
        }
        fetchAllIntegrationStatuses(false); // Refresh to get the latest status

        // Clean up URL by removing oauth_callback, platform, error, and error_description query parameters
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('oauth_callback');
        newUrl.searchParams.delete('platform');
        newUrl.searchParams.delete('error');
        newUrl.searchParams.delete('error_description');
        window.history.replaceState({}, '', newUrl.toString());
      }

       // Reset connecting state regardless of success or failure of OAuth
       if (platform && operationStates[platform]?.isConnecting) {
         setOperationStates(prev => ({ ...prev, [platform]: { isConnecting: false }}));
       }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchAllIntegrationStatuses]); // operationStates is intentionally omitted to avoid loop if it changes for other reasons

  if (loadingGlobal) {
    return (
      // The main padding is now handled by LayoutWithSidebar's children container
      // This component's root div will just manage its internal spacing.
      <div className="space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Manage Integrations</h1> {/* Enhanced heading */}
            <p className="text-muted-foreground mt-2 text-base"> {/* Enhanced paragraph */}
              Connect your favorite tools to enhance your experience.
            </p>
          </div>
           <Skeleton className="h-10 w-36 mt-4 sm:mt-0" /> {/* Adjusted width */}
        </div>
        <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3"> {/* Added xl:grid-cols-3 */}
          {AVAILABLE_INTEGRATIONS_CONFIG.map(config => (
            <Card key={config.platform} className="w-full">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-7 w-7 rounded-md" />
                    <Skeleton className="h-6 w-24" /> {/* Simulates CardTitle */}
                  </div>
                  <Skeleton className="h-6 w-28 rounded-md" /> {/* Simulates Badge */}
                </div>
                <Skeleton className="h-4 w-full mt-2" /> {/* Simulates CardDescription line 1 */}
                <Skeleton className="h-4 w-3/4 mt-1" /> {/* Simulates CardDescription line 2 */}
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-1/2" /> {/* Simulates connected user info */}
              </CardContent>
              <CardFooter className="flex justify-end">
                <Skeleton className="h-10 w-32" /> {/* Simulates Button */}
              </CardFooter>
            </Card>
          ))}
        </div> {/* Closing for: <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2"> */}
      </div> // Closing for: <div className="space-y-8 p-4 md:p-6">
    );
  }

  return (
    <div className="space-y-8"> {/* Removed padding, handled by parent layout */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Manage Integrations</h1> {/* Enhanced heading */}
            <p className="text-muted-foreground mt-2 text-base"> {/* Enhanced paragraph */}
            Connect your favorite tools to enhance your experience.
            </p>
        </div>
        <Button
            variant="outline"
            size="lg" // Larger button
            onClick={() => !loadingGlobal && fetchAllIntegrationStatuses()}
            disabled={loadingGlobal || Object.values(operationStates).some(s => s.isConnecting || s.isDisconnecting)}
            className="mt-4 sm:mt-0"
        >
            <RefreshCw className={`mr-2 h-4 w-4 ${loadingGlobal ? 'animate-spin' : ''}`} />
            Refresh Statuses
        </Button>
      </div> {/* Closing for: <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between"> */}

      {Object.values(integrationStatuses).every(s => s === undefined) && !loadingGlobal && (
        <div className="text-center text-muted-foreground py-12 px-6 border-2 border-dashed rounded-lg"> {/* Increased padding, thicker border */}
            <ZapOff className="mx-auto h-16 w-16 text-muted-foreground/70" /> {/* Larger icon, adjusted color */}
            <h3 className="mt-4 text-lg font-medium text-foreground">No Integrations Found</h3> {/* Enhanced heading */}
            <p className="mt-1.5 text-base text-muted-foreground"> {/* Enhanced paragraph */}
              Could not load integration statuses or none are available.
            </p>
            <div className="mt-8"> {/* Increased margin */}
                <Button
                    variant="default" // Changed to default for more prominence
                    size="lg" // Larger button
                    onClick={() => !loadingGlobal && fetchAllIntegrationStatuses()}
                    disabled={loadingGlobal || Object.values(operationStates).some(s => s.isConnecting || s.isDisconnecting)}
                >
                    <RefreshCw className={`mr-2 h-4 w-4 ${loadingGlobal ? 'animate-spin' : ''}`} />
                    Try Refreshing
                </Button>
            </div>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3"> {/* Added xl:grid-cols-3 */}
        {AVAILABLE_INTEGRATIONS_CONFIG.map(config => {
          const status = integrationStatuses[config.platform];
          const opsState = operationStates[config.platform] || {};
          const isLoadingCard = opsState.isConnecting || opsState.isDisconnecting;

          // Only render card if config exists, even if status is undefined (means not connected or error fetching)
          return (
            <IntegrationCard
              key={config.platform}
              integrationConfig={config}
              status={status} // Can be undefined
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              isLoading={isLoadingCard ?? false}
              isConnecting={opsState.isConnecting}
              isDisconnecting={opsState.isDisconnecting}
            />
          );
        })}
      </div> {/* Closing for: <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-2"> */}
    </div> // Closing for: <div className="space-y-8 p-4 md:p-6">
  );
};

export default IntegrationsSettingsPage;