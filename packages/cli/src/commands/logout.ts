import { Command } from 'commander';
import { clearApiKey, isAuthenticated } from '../utils/config';
import { success, error, info } from '../utils/ui';
import { getApiClient, clearApiClientInstance } from '../utils/apiClient';
import { DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';

/**
 * Register the logout command
 * @param program The commander program
 */
export function logoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Log out from the dome API')
    .action(async () => {
      try {
        // Check if authenticated locally first
        if (!isAuthenticated()) {
          console.log(info('You are not logged in.'));
          return;
        }

        const apiClient = getApiClient();
        // Attempt to log out from the server
        // The SDK's logout method might require an active token to invalidate it on the server.
        // If the token is already invalid or expired, this might fail, but we still want to clear local data.
        try {
          const logoutResult = await apiClient.auth.userLogout();
          if (logoutResult.success) {
            console.log(info('Successfully logged out from server.'));
          } else {
            // Even if server logout fails (e.g. token already expired), proceed to clear local data
            console.log(info(`Server logout message: ${logoutResult.message}. Clearing local session.`));
          }
        } catch (serverLogoutError: unknown) {
          let serverErrorMessage = 'An error occurred during server logout.';
          if (serverLogoutError instanceof DomeApiError) {
            const apiError = serverLogoutError as DomeApiError;
            const status = apiError.statusCode ?? 'N/A';
            let detailMessage = apiError.message;
            if (apiError.body && typeof apiError.body === 'object' && apiError.body !== null && 'message' in apiError.body && typeof (apiError.body as any).message === 'string') {
                detailMessage = (apiError.body as { message: string }).message;
            }
            serverErrorMessage = `Server logout error: ${detailMessage} (Status: ${status})`;
          } else if (serverLogoutError instanceof DomeApiTimeoutError) {
            const timeoutError = serverLogoutError as DomeApiTimeoutError;
            serverErrorMessage = `Server logout error: Request timed out. ${timeoutError.message}`;
          } else if (serverLogoutError instanceof Error) {
            serverErrorMessage = `Server logout error: ${serverLogoutError.message}`;
          }
          console.log(error(serverErrorMessage + ' Proceeding with local logout.'));
        }

        // Clear local API key and cached client instance
        clearApiKey(); // This should also clear userId if it's part of the same config
        clearApiClientInstance();

        console.log(success('Successfully logged out locally.'));
      } catch (err: unknown) {
        // This catch block is for unexpected errors in the main logout command logic itself
        let generalErrorMessage = 'Failed to complete logout process.';
        if (err instanceof Error) {
            generalErrorMessage = `Failed to complete logout process: ${err.message}`;
        }
        console.log(error(generalErrorMessage));
        process.exit(1);
      }
    });
}
