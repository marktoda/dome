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
    const response = await fetch(`${AUTH_SERVICE_URL}/send-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phoneNumber }),
    });
    
    const data = await response.json();
    
    if (!data.success) {
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
 * Main function to run the authentication flow
 */
async function main() {
  try {
    console.log('🚀 Starting Telegram Authentication Flow');
    console.log('=======================================');
    
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
  } finally {
    rl.close();
  }
}

// Run the main function
main();