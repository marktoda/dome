"use client";

import React from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Integration, IntegrationStatus, IntegrationPlatform } from '@/lib/oauth-types';
import { ExternalLink, Zap, ZapOff, RefreshCw } from 'lucide-react';

/**
 * Props for the icon elements used within the {@link IntegrationCard}.
 * Allows specifying size and className for the integration's icon.
 */
interface IconProps {
  /** The size of the icon (width and height). */
  size?: number;
  /** Additional CSS class names for the icon. */
  className?: string;
}

/**
 * Props for the {@link IntegrationCard} component.
 */
interface IntegrationCardProps {
  /** Base configuration details for the integration (name, description, icon, platform). */
  integrationConfig: Omit<Integration, 'isConnected'>;
  /** Optional current status of the integration (isConnected, user details, etc.), usually fetched dynamically. */
  status?: IntegrationStatus;
  /**
   * Callback function to initiate the connection process for the integration.
   * This function is expected to trigger the OAuth flow, often by redirecting the user.
   * @param platform - The platform identifier of the integration to connect.
   */
  onConnect: (platform: IntegrationPlatform) => void;
  /**
   * Callback function to initiate the disconnection process for the integration.
   * This function should call the backend API to revoke the integration's access.
   * @param platform - The platform identifier of the integration to disconnect.
   * @returns A promise that resolves when the disconnection attempt is complete.
   */
  onDisconnect: (platform: IntegrationPlatform) => Promise<void>;
  /** General loading state for any operation related to this card (connect, disconnect, status fetch). */
  isLoading: boolean;
  /** Specific loading state for the connection operation. */
  isConnecting?: boolean;
  /** Specific loading state for the disconnection operation. */
  isDisconnecting?: boolean;
}

/**
 * `IntegrationCard` displays information about a third-party integration and allows users to connect or disconnect it.
 * It shows the integration's name, icon, description, and current connection status.
 * Provides buttons to initiate connection or disconnection, with loading states.
 *
 * @param props - The props for the component.
 * @returns A React functional component representing an integration card.
 */
const IntegrationCard: React.FC<IntegrationCardProps> = ({
  integrationConfig,
  status,
  onConnect,
  onDisconnect,
  isLoading, // General loading state for the card
  isConnecting, // Specific loading state for connect action
  isDisconnecting, // Specific loading state for disconnect action
}) => {
  const isConnected = status?.isConnected || false;

  /**
   * Handles the click event for the "Connect" button.
   * Invokes the `onConnect` callback with the integration's platform.
   */
  const handleConnectClick = () => {
    if (isLoading || isConnecting) return; // Prevent action if already loading
    onConnect(integrationConfig.platform);
  };

  /**
   * Handles the click event for the "Disconnect" button.
   * Invokes the `onDisconnect` callback with the integration's platform.
   */
  const handleDisconnectClick = async () => {
    if (isLoading || isDisconnecting) return; // Prevent action if already loading
    await onDisconnect(integrationConfig.platform);
  };

  return (
    <Card className="w-full flex flex-col transition-all hover:shadow-lg"> {/* Added hover effect and flex-col for consistent footer */}
      <CardHeader className="pb-3"> {/* Adjusted padding */}
        <div className="flex items-start justify-between gap-3"> {/* items-start for better alignment with multi-line title/desc */}
          <div className="flex items-center gap-3">
            {integrationConfig.icon && React.cloneElement(integrationConfig.icon as React.ReactElement<IconProps>, { size: 28, className: "text-muted-foreground" })} {/* Slightly larger icon */}
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