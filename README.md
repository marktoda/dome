# Telegram Authentication Flow Script

This script walks through the Telegram authentication flow to generate a session. It interacts with the telegram-auth service running at http://localhost:8788.

## Prerequisites

- Node.js installed on your system
- The telegram-auth service running at http://localhost:8788
- A Telegram account with the phone number specified in the script

## Installation

1. Install the dependencies:

```bash
npm install
```

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
