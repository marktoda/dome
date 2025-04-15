# Telegram Authentication Flow Script

This script walks through the Telegram authentication flow to generate a session. It interacts with the telegram-auth service running at http://localhost:8788.

## Prerequisites

- Node.js installed on your system
- The telegram-auth service running at http://localhost:8788
- A Telegram account with the phone number specified in the script
- Telegram API credentials (API ID and API Hash) from https://my.telegram.org/apps

## Installation

1. Install the dependencies:

```bash
npm install
```

## Configuration

Before using the script, you need to configure the telegram-auth service with your Telegram API credentials using Cloudflare secrets:

1. Go to https://my.telegram.org/apps and log in with your Telegram account
2. Create a new application if you don't have one already
3. Note your API ID and API Hash
4. Set up the secrets using the Wrangler CLI:

   ```bash
   # Navigate to the auth-telegram service directory
   cd services/auth-telegram
   
   # Set the Telegram API ID secret
   npx wrangler secret put TELEGRAM_API_ID
   # Enter your API ID when prompted
   
   # Set the Telegram API Hash secret
   npx wrangler secret put TELEGRAM_API_HASH
   # Enter your API Hash when prompted
   
   # Set a random session secret
   npx wrangler secret put SESSION_SECRET
   # Enter a random string when prompted
   ```

5. Restart the telegram-auth service

## Usage

1. Make sure the telegram-auth service is running at http://localhost:8788
2. Run the script:

```bash
npm start
```

3. The script will:
   - Send an authentication code to your phone number
   - Prompt you to enter the code you received
   - Verify the code and generate a session
   - Display the session ID and other details

## How It Works

The script follows these steps:

1. Sends a request to `/api/telegram-auth/send-code` with your phone number
2. Waits for you to receive and enter the authentication code
3. Sends a request to `/api/telegram-auth/verify-code` with the code to verify and get a session
4. Checks the authentication status using the generated session ID

## Customization

If you need to use a different phone number, edit the `PHONE_NUMBER` constant in the script.

If the telegram-auth service is running at a different URL, edit the `AUTH_SERVICE_URL` constant in the script.

## Troubleshooting

### API ID or Hash cannot be empty

If you see an error like "API ID or Hash cannot be empty", it means the telegram-auth service is not properly configured with Telegram API credentials. Follow the steps in the Configuration section to set up your API ID and API Hash as Cloudflare secrets.

### WebSocket connection failed

If you see an error like "WebSocket connection failed" or "TypeError: this.client.on is not a function", it might be due to compatibility issues with the Telegram client library in the Cloudflare Workers environment. This is a known limitation when running the Telegram client in a serverless environment. You may need to:

1. Make sure you're using the `nodejs_compat` flag in your wrangler.toml (which is already set)
2. Consider using a different approach for Telegram authentication, such as a dedicated server for handling Telegram API interactions

### Service not available

If the service is not available at http://localhost:8788, make sure the telegram-auth service is running. You can start it with:

```bash
cd services/auth-telegram
pnpm dev
```

### Authentication code not received

If you don't receive the authentication code:
1. Make sure your phone number is correct
2. Check that your Telegram account is active
3. Try again after a few minutes
