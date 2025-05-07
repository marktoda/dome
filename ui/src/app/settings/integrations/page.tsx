import React from 'react';
import IntegrationsSettingsPageDisplay from '@/components/settings/IntegrationsSettingsPage';
// Toaster removed, Sonner in RootLayout will handle toasts

export const metadata = {
  title: 'Manage Integrations',
  description: 'Connect and manage your third-party application integrations.',
};

export default function IntegrationsSettingsRoute() {
  return (
    // The outer div is removed. LayoutWithSidebar and Header will provide the page structure.
    // Padding and max-width for the content itself should be handled within IntegrationsSettingsPageDisplay
    // or a wrapper inside it if needed.
    <IntegrationsSettingsPageDisplay />
    // Toaster removed
  );
}