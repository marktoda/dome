"use client";

import React from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Integration, IntegrationStatus, IntegrationPlatform } from '@/lib/oauth-types';
import { ExternalLink, Zap, ZapOff, RefreshCw } from 'lucide-react';

interface IntegrationCardProps {
  integrationConfig: Omit<Integration, 'isConnected'>; // Base details from a config object
  status?: IntegrationStatus; // Current status, fetched separately
  onConnect: (platform: IntegrationPlatform) => void; // Should initiate the API call that redirects
  onDisconnect: (platform: IntegrationPlatform) => Promise<void>; // Should call the disconnect API
  isLoading: boolean; // True if any operation for this card is in progress
  isConnecting?: boolean; // Specifically for connect operation
  isDisconnecting?: boolean; // Specifically for disconnect operation
}

const IntegrationCard: React.FC<IntegrationCardProps> = ({
  integrationConfig,
  status,
  onConnect,
  onDisconnect,
  isLoading,
  isConnecting,
  isDisconnecting,
}) => {
  const isConnected = status?.isConnected || false;

  const handleConnectClick = () => {
    // The onConnect function will typically make window.location.href change
    // to the backend route that starts the OAuth flow.
    onConnect(integrationConfig.platform);
  };

  const handleDisconnectClick = async () => {
    await onDisconnect(integrationConfig.platform);
  };

  return (
    <Card className="w-full flex flex-col transition-all hover:shadow-lg"> {/* Added hover effect and flex-col for consistent footer */}
      <CardHeader className="pb-3"> {/* Adjusted padding */}
        <div className="flex items-start justify-between gap-3"> {/* items-start for better alignment with multi-line title/desc */}
          <div className="flex items-center gap-3">
            {integrationConfig.icon && React.cloneElement(integrationConfig.icon as React.ReactElement, { size: 28, className: "text-muted-foreground" })} {/* Slightly larger icon */}
            <CardTitle className="text-lg font-semibold">{integrationConfig.name}</CardTitle> {/* Enhanced title */}
          </div>
          <Badge
            variant={isConnected ? "default" : "outline"}
            className={`whitespace-nowrap text-xs font-medium py-1 px-2.5 rounded-full ${
              isConnected
                ? 'bg-green-600 hover:bg-green-600/90 text-white border-transparent' // Shadcn success-like badge
                : 'border-border text-muted-foreground'
            }`}
          >
            {isConnected ? (
              <>
                <Zap className="mr-1.5 h-3.5 w-3.5" /> Connected
              </>
            ) : (
              <>
                <ZapOff className="mr-1.5 h-3.5 w-3.5" /> Disconnected
              </>
            )}
          </Badge>
        </div>
        <CardDescription className="mt-1.5 text-sm leading-relaxed">{integrationConfig.description}</CardDescription> {/* Enhanced description */}
      </CardHeader>
      <CardContent className="flex-grow pb-3"> {/* flex-grow to push footer down, adjusted padding */}
        {isConnected && status?.user?.name && (
          <p className="text-sm text-muted-foreground">
            Connected as: <strong className="font-medium text-foreground">{status.user.name}</strong>
            {status.user.email && ` (${status.user.email})`}
          </p>
        )}
        {!isConnected && (
            <p className="text-sm text-muted-foreground italic">
                Connect your {integrationConfig.name} account to enable new features.
            </p>
        )}
      </CardContent>
      <CardFooter className="flex justify-end pt-0 pb-4 px-4 border-t mt-auto"> {/* Added border-t, mt-auto, adjusted padding */}
        {isConnected ? (
          <Button variant="destructive" size="sm" onClick={handleDisconnectClick} disabled={isLoading || isDisconnecting} className="hover:bg-destructive/90 transition-colors"> {/* Changed to destructive, adjusted size and hover */}
            {isDisconnecting ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : null}
            {isDisconnecting ? "Disconnecting..." : "Disconnect"}
          </Button>
        ) : (
          <Button variant="default" size="sm" onClick={handleConnectClick} disabled={isLoading || isConnecting} className="hover:bg-primary/90 transition-colors"> {/* Adjusted size and hover */}
            {isConnecting ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : null}
            {isConnecting ? "Connecting..." : `Connect ${integrationConfig.name}`}
            {!isConnecting && <ExternalLink className="ml-1.5 h-4 w-4" />} {/* Adjusted margin */}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
};

export default IntegrationCard;