/**
 * Telegram Client Wrapper
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Logger } from 'telegram/extensions/Logger';

// Set logging level
Logger.setLevel('error');

/**
 * Result of sending authentication code
 */
export interface SendCodeResult {
  phoneCodeHash: string;
  isCodeViaApp: boolean;
  timeout: number;
}

/**
 * Result of verifying authentication code
 */
export interface VerifyCodeResult {
  userId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  sessionString: string;
}

/**
 * Telegram Client Wrapper
 */
export class TelegramClientWrapper {
  private apiId: number;
  private apiHash: string;
  
  /**
   * Constructor
   * @param apiId - Telegram API ID
   * @param apiHash - Telegram API Hash
   */
  constructor(apiId: string, apiHash: string) {
    this.apiId = parseInt(apiId, 10);
    this.apiHash = apiHash;
  }
  
  /**
   * Send authentication code to phone number
   * @param phoneNumber - The phone number to send code to
   * @returns SendCodeResult with code hash and other details
   */
  async sendAuthCode(phoneNumber: string): Promise<SendCodeResult> {
    // Create a new client with an empty session
    const client = new TelegramClient(
      new StringSession(''),
      this.apiId,
      this.apiHash,
      { connectionRetries: 3 }
    );
    
    try {
      // Connect to Telegram
      await client.connect();
      
      // Use type assertion to work around type checking issues
      // The actual API might have changed from what the types suggest
      const result = await (client as any).sendCode(
        phoneNumber,
        this.apiId,
        this.apiHash
      );
      
      // Create a standardized result object with safe defaults
      return {
        phoneCodeHash: result.phoneCodeHash,
        isCodeViaApp: false, // Default value
        timeout: 120 // Default timeout in seconds
      };
    } finally {
      // Disconnect the client
      await client.disconnect();
    }
  }
  
  /**
   * Verify authentication code
   * @param phoneNumber - The phone number
   * @param phoneCodeHash - The phone code hash from sendAuthCode
   * @param code - The authentication code received by the user
   * @returns VerifyCodeResult with user details and session string
   */
  async verifyAuthCode(
    phoneNumber: string,
    phoneCodeHash: string,
    code: string
  ): Promise<VerifyCodeResult> {
    // Create a new client with an empty session
    const session = new StringSession('');
    const client = new TelegramClient(
      session,
      this.apiId,
      this.apiHash,
      { connectionRetries: 3 }
    );
    
    try {
      // Connect to Telegram
      await client.connect();
      
      // Sign in with the code
      // Use a more type-safe approach
      await client.start({
        phoneNumber: async () => phoneNumber,
        password: async () => '',
        phoneCode: async () => code,
        onError: (err) => console.error(err),
      });
      
      // Get user information
      const me = await client.getMe();
      
      // Get the session string for storage
      // Handle the case where save() returns void by storing the string beforehand
      const stringSession = client.session as StringSession;
      const sessionString = stringSession.toString();
      
      return {
        userId: typeof me.id === 'number' ? me.id : parseInt(String(me.id), 10),
        firstName: typeof me.firstName === 'string' ? me.firstName : undefined,
        lastName: typeof me.lastName === 'string' ? me.lastName : undefined,
        username: typeof me.username === 'string' ? me.username : undefined,
        sessionString
      };
    } finally {
      // Disconnect the client
      await client.disconnect();
    }
  }
  
  /**
   * Create a client from a session string
   * @param sessionString - The session string
   * @returns Connected TelegramClient
   */
  async createClientFromSession(sessionString: string): Promise<TelegramClient> {
    // Create a client with the provided session
    const session = new StringSession(sessionString);
    const client = new TelegramClient(
      session,
      this.apiId,
      this.apiHash,
      { connectionRetries: 3 }
    );
    
    // Connect to Telegram
    await client.connect();
    
    return client;
  }
}