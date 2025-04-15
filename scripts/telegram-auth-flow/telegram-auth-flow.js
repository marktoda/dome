/**
 * Telegram Authentication Flow Script
 * 
 * This script walks through the Telegram authentication flow to generate a session.
 * It interacts with the telegram-auth service running at http://localhost:8788.
 */

const readline = require('readline');
const fetch = require('node-fetch');

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Configuration
const AUTH_SERVICE_URL = 'http://localhost:8788/api/telegram-auth';
const PHONE_NUMBER = '+15037245117'; // User's phone number

/**
 * Prompt user for input
 * @param {string} question - The question to ask
 * @returns {Promise<string>} - User's response
 */
function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Send authentication code to phone number
 * @param {string} phoneNumber - The phone number to send code to
 * @returns {Promise<object>} - Response with phoneCodeHash
 */
async function sendAuthCode(phoneNumber) {
  console.log(`\n📱 Sending authentication code to ${phoneNumber}...`);
  
  try {
    // First check if the service is properly configured by calling the health endpoint
    const healthResponse = await fetch(`${AUTH_SERVICE_URL}/health`);
    
    if (!healthResponse.ok) {
      throw new Error(`Telegram auth service is not available at ${AUTH_SERVICE_URL}`);
    }
    
    const response = await fetch(`${AUTH_SERVICE_URL}/send-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phoneNumber }),
    });
    
    const data = await response.json();
    
    if (!data.success) {
      if (data.error?.message?.includes('API ID or Hash cannot be empty')) {
        throw new Error(
          'The Telegram auth service is not properly configured. ' +
          'Please set the TELEGRAM_API_ID and TELEGRAM_API_HASH as Cloudflare secrets.'
        );
      }
      
      if (data.error?.message?.includes('WebSocket connection failed') ||
          data.error?.message?.includes('this.client.on is not a function')) {
        throw new Error(
          'WebSocket connection failed. This is a known limitation when running the Telegram client ' +
          'in a Cloudflare Workers environment. Consider using a different approach for Telegram authentication.'
        );
      }
      throw new Error(data.error?.message || 'Failed to send authentication code');
    }
    
    console.log('✅ Authentication code sent successfully!');
    console.log(`📝 Phone code hash: ${data.data.phoneCodeHash}`);
    console.log(`⏱️ Timeout: ${data.data.timeout} seconds`);
    
    return data.data;
  } catch (error) {
    console.error('❌ Error sending authentication code:', error.message);
    throw error;
  }
}

/**
 * Verify authentication code
 * @param {string} phoneNumber - The phone number
 * @param {string} phoneCodeHash - The phone code hash from sendAuthCode
 * @param {string} code - The authentication code received by the user
 * @returns {Promise<object>} - Response with session details
 */
async function verifyAuthCode(phoneNumber, phoneCodeHash, code) {
  console.log('\n🔐 Verifying authentication code...');
  
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/verify-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumber,
        phoneCodeHash,
        code,
      }),
    });
    
    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.error?.message || 'Failed to verify authentication code');
    }
    
    console.log('✅ Authentication code verified successfully!');
    console.log(`🔑 Session ID: ${data.data.sessionId}`);
    console.log(`📅 Expires at: ${data.data.expiresAt}`);
    
    return data.data;
  } catch (error) {
    console.error('❌ Error verifying authentication code:', error.message);
    throw error;
  }
}

/**
 * Check authentication status
 * @param {string} sessionId - The session ID
 * @returns {Promise<object>} - Response with authentication status
 */
async function checkAuthStatus(sessionId) {
  console.log('\n🔍 Checking authentication status...');
  
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/status?sessionId=${sessionId}`);
    const data = await response.json();
    
    console.log(`🔐 Authenticated: ${data.data.authenticated}`);
    
    if (data.data.authenticated) {
      console.log(`👤 User ID: ${data.data.userId}`);
      console.log(`📅 Session expires at: ${data.data.sessionExpiresAt}`);
    }
    
    return data.data;
  } catch (error) {
    console.error('❌ Error checking authentication status:', error.message);
    throw error;
  }
}

/**
 * Check if the Telegram auth service is properly configured
 * @returns {Promise<boolean>} - True if the service is properly configured
 */
async function checkServiceConfiguration() {
  try {
    // Check if the service has the required secrets
    console.log('\n🔍 Checking if the Telegram auth service is properly configured...');
    console.log('Make sure the following Cloudflare secrets are set:');
    console.log('  - TELEGRAM_API_ID');
    console.log('  - TELEGRAM_API_HASH');
    console.log('  - SESSION_SECRET');
    
    // Call the health endpoint to check if the service is running
    const healthResponse = await fetch(`${AUTH_SERVICE_URL}/health`);
    
    if (!healthResponse.ok) {
      console.error(`❌ Telegram auth service is not available at ${AUTH_SERVICE_URL}`);
      return false;
    }
    
    console.log(`✅ Telegram auth service is running at ${AUTH_SERVICE_URL}`);
    return true;
  } catch (error) {
    console.error(`❌ Error checking service configuration: ${error.message}`);
    return false;
  }
}

/**
 * Main function to run the authentication flow
 */
async function main() {
  try {
    console.log('🚀 Starting Telegram Authentication Flow');
    console.log('=======================================');
    
    // Check if the service is properly configured
    const isConfigured = await checkServiceConfiguration();
    
    if (!isConfigured) {
      console.log('\n⚠️ The Telegram auth service may not be properly configured.');
      const proceed = await prompt('Do you want to proceed anyway? (y/n): ');
      
      if (proceed.toLowerCase() !== 'y') {
        console.log('Exiting...');
        return;
      }
    }
    
    // Step 1: Send authentication code
    const sendCodeResult = await sendAuthCode(PHONE_NUMBER);
    
    // Step 2: Prompt user for the code they received
    const code = await prompt('\n📲 Enter the authentication code you received: ');
    
    // Step 3: Verify the code
    const verifyResult = await verifyAuthCode(
      PHONE_NUMBER,
      sendCodeResult.phoneCodeHash,
      code
    );
    
    // Step 4: Check authentication status
    await checkAuthStatus(verifyResult.sessionId);
    
    console.log('\n🎉 Authentication flow completed successfully!');
    console.log(`📝 Save this session ID for future use: ${verifyResult.sessionId}`);
    
  } catch (error) {
    console.error('\n❌ Authentication flow failed:', error.message);
    
    if (error.message.includes('API ID or Hash cannot be empty') ||
        error.message.includes('not properly configured')) {
      console.log('\n📝 To fix this issue:');
      console.log('1. Obtain your API ID and API Hash from https://my.telegram.org/apps');
      console.log('2. Set them as Cloudflare secrets using the following commands:');
      console.log('   cd services/auth-telegram');
      console.log('   npx wrangler secret put TELEGRAM_API_ID');
      console.log('   npx wrangler secret put TELEGRAM_API_HASH');
      console.log('3. Restart the telegram-auth service');
    }
    
    if (error.message.includes('WebSocket connection failed') ||
        error.message.includes('this.client.on is not a function')) {
      console.log('\n📝 This is a known limitation when running the Telegram client in a Cloudflare Workers environment.');
      console.log('To fix this issue, you may need to:');
      console.log('1. Consider using a different approach for Telegram authentication');
      console.log('2. Run the Telegram client on a dedicated server instead of a Cloudflare Worker');
      console.log('3. Use a different library that is compatible with the Cloudflare Workers environment');
    }
  } finally {
    rl.close();
  }
}

// Run the main function
main();