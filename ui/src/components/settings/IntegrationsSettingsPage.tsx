"use client";

import React, { useState, useEffect, useCallback } from 'react';
import type { IntegrationStatus, Integration, IntegrationPlatform } from '@/lib/oauth-types';
import IntegrationCard from './IntegrationCard';
import { Github, BookText, RefreshCw, ZapOff } from 'lucide-react'; // Added ZapOff, Using BookText for Notion
import { Skeleton } from '@/components/ui/skeleton';
import { toast as sonnerToast } from 'sonner'; // Assuming sonner is used globally for toasts
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'; // Added imports

// Define your available integrations configuration
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

const IntegrationsSettingsPage: React.FC = () => {
  const [integrationStatuses, setIntegrationStatuses] = useState<Record<IntegrationPlatform, IntegrationStatus | undefined>>({
    github: undefined,
    notion: undefined,
  });
  const [loadingGlobal, setLoadingGlobal] = useState<boolean>(true);
  const [operationStates, setOperationStates] = useState<Record<IntegrationPlatform, {isConnecting?: boolean, isDisconnecting?: boolean}>>({
    github: {},
    notion: {},
  });
  // const { toast } = useToast(); // Replaced with sonnerToast

  const fetchAllIntegrationStatuses = useCallback(async (showLoadingIndicator = true) => {
    if (showLoadingIndicator) {
        setLoadingGlobal(true);
    }
    try {
      const response = await fetch('/api/settings/integrations');
      if (!response.ok) {
        throw new Error('Failed to fetch integration statuses');
      }
      const data: IntegrationStatus[] = await response.json();
      const newStatuses: Record<IntegrationPlatform, IntegrationStatus | undefined> = { github: undefined, notion: undefined };
      data.forEach(status => {
        newStatuses[status.platform] = status;
      });
      setIntegrationStatuses(newStatuses);
    } catch (error) {
      console.error("Error fetching statuses:", error);
      sonnerToast.error("Error Loading Integrations", { // Using sonnerToast
        description: "Could not load integration statuses. Please try refreshing.",
      });
    } finally {
      if (showLoadingIndicator) {
        setLoadingGlobal(false);
      }
    }
  }, []); // Removed toast from dependencies as sonnerToast is global

  useEffect(() => {
    fetchAllIntegrationStatuses();
  }, [fetchAllIntegrationStatuses]);

  const handleConnect = (platform: IntegrationPlatform) => {
    setOperationStates(prev => ({ ...prev, [platform]: { isConnecting: true, isDisconnecting: false }}));
    const connectUrl = AVAILABLE_INTEGRATIONS_CONFIG.find(i => i.platform === platform)?.connectUrl;
    if (connectUrl) {
      // Add current path for redirect_uri to ensure user returns to the integrations page
      const redirectUri = encodeURIComponent('/settings/integrations?oauth_callback=true&platform=' + platform);
      window.location.href = `${connectUrl}?redirect_uri=${redirectUri}`;
    } else {
      sonnerToast.error("Error", { description: "Connect URL not found." }); // Using sonnerToast
      setOperationStates(prev => ({ ...prev, [platform]: { isConnecting: false }}));
    }
  };

  const handleDisconnect = async (platform: IntegrationPlatform) => {
    setOperationStates(prev => ({ ...prev, [platform]: { isDisconnecting: true, isConnecting: false }}));
    try {
      const integrationConfig = AVAILABLE_INTEGRATIONS_CONFIG.find(i => i.platform === platform);
      if (!integrationConfig) throw new Error("Invalid integration platform");

      const response = await fetch(integrationConfig.disconnectUrl, { method: 'POST' });
      const responseData = await response.json();

      if (!response.ok || !responseData.success) {
        throw new Error(responseData.message || `Failed to disconnect ${integrationConfig.name}.`);
      }
      sonnerToast.success("Success", { // Using sonnerToast
        description: `${integrationConfig.name} disconnected successfully.`,
      });
      await fetchAllIntegrationStatuses(false); // Refresh statuses without global loading
    } catch (error) {
      console.error(`Error disconnecting ${platform}:`, error);
      const integrationConfig = AVAILABLE_INTEGRATIONS_CONFIG.find(i => i.platform === platform);
      sonnerToast.error("Error", { // Using sonnerToast
        description: `Could not disconnect ${integrationConfig?.name || platform}. ${(error as Error).message}`,
      });
    } finally {
      setOperationStates(prev => ({ ...prev, [platform]: { isDisconnecting: false }}));
    }
  };
  
  useEffect(() => {
    const queryParams = new URLSearchParams(window.location.search);
    if (queryParams.get('oauth_callback') === 'true') {
      const platform = queryParams.get('platform') as IntegrationPlatform | null;
      if (platform) {
        // Assume success for mock, real app would check for error params from OAuth provider
        sonnerToast.success("Connected!", { // Using sonnerToast
          description: `${AVAILABLE_INTEGRATIONS_CONFIG.find(i => i.platform === platform)?.name || platform} connected successfully.`,
        });
        fetchAllIntegrationStatuses(false); // Refresh to get the latest status
         // Clean up URL
        const newUrl = window.location.pathname;
        window.history.replaceState({}, '', newUrl);
      }
       if (platform && operationStates[platform]?.isConnecting) {
         setOperationStates(prev => ({ ...prev, [platform]: { isConnecting: false }}));
       }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchAllIntegrationStatuses]); // Removed toast from dependencies

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