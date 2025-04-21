/**
 * Crypto helper functions for tests
 * Uses Web Crypto API instead of Node.js crypto
 */

/**
 * Create a signed webhook payload using Web Crypto API
 * @param payload The webhook payload
 * @param secret The webhook secret
 * @returns The signature and body
 */
export async function createSignedWebhook(payload: any, secret: string): Promise<{ signature: string; body: string }> {
  const body = JSON.stringify(payload);
  const encoder = new TextEncoder();
  
  // Import the secret as a key
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  // Sign the payload
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(body)
  );
  
  // Convert the signature to hex
  const hashArray = Array.from(new Uint8Array(signature));
  const hexSignature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return {
    signature: `sha256=${hexSignature}`,
    body,
  };
}