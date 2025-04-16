/**
 * Encryption utilities for secure session storage
 */

/**
 * Encrypts data using AES-GCM
 * @param data - The data to encrypt
 * @param masterKey - The master encryption key
 * @param salt - Unique salt for this encryption
 * @returns Object containing encrypted data and IV
 */
export async function encrypt(
  data: string,
  masterKey: string,
  salt: string,
): Promise<{ encryptedData: Uint8Array; iv: string }> {
  // Import the master key
  const key = await importKey(masterKey);

  // Derive a key for this specific encryption
  const derivedKey = await deriveKey(key, salt);

  // Generate a random IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt the data
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);

  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    derivedKey,
    dataBuffer,
  );

  // Convert IV to Base64 for storage
  const ivBase64 = btoa(String.fromCharCode(...iv));

  return {
    encryptedData: new Uint8Array(encryptedBuffer),
    iv: ivBase64,
  };
}

/**
 * Decrypts data using AES-GCM
 * @param encryptedData - The encrypted data
 * @param iv - The initialization vector used for encryption
 * @param masterKey - The master encryption key
 * @param salt - The salt used for key derivation
 * @returns Decrypted data as a string
 */
export async function decrypt(
  encryptedData: Uint8Array,
  iv: string,
  masterKey: string,
  salt: string,
): Promise<string> {
  // Import the master key
  const key = await importKey(masterKey);

  // Derive the same key used for encryption
  const derivedKey = await deriveKey(key, salt);

  // Convert IV from Base64
  const ivBytes = atob(iv);
  const ivBuffer = new Uint8Array(ivBytes.length);
  for (let i = 0; i < ivBytes.length; i++) {
    ivBuffer[i] = ivBytes.charCodeAt(i);
  }

  // Decrypt the data
  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: ivBuffer,
    },
    derivedKey,
    encryptedData,
  );

  // Convert back to string
  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuffer);
}

/**
 * Imports a key for use with PBKDF2
 * @param keyString - The key as a string
 * @returns CryptoKey for use with deriveKey
 */
async function importKey(keyString: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(keyString);

  return await crypto.subtle.importKey('raw', keyData, { name: 'PBKDF2' }, false, ['deriveKey']);
}

/**
 * Derives an encryption key using PBKDF2
 * @param masterKey - The master key
 * @param salt - The salt for key derivation
 * @returns CryptoKey for use with encrypt/decrypt
 */
async function deriveKey(masterKey: CryptoKey, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const saltBuffer = encoder.encode(salt);

  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: 100000,
      hash: 'SHA-256',
    },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Generates a random string for use as a salt or ID
 * @param length - The length of the random string
 * @returns Random string
 */
export function generateRandomString(length = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, length);
}
