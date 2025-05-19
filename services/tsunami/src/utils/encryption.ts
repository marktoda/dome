export async function deriveKey(
  secret: string,
  usage: Array<'encrypt' | 'decrypt'>,
): Promise<CryptoKey> {
  const enc = new TextEncoder().encode(secret);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, usage);
}

export async function encryptString(data: string, secret: string): Promise<string> {
  const key = await deriveKey(secret, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const result = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.byteLength);
  return btoa(String.fromCharCode(...result));
}

export async function decryptString(data: string, secret: string): Promise<string> {
  const raw = atob(data);
  const buffer = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buffer[i] = raw.charCodeAt(i);
  const iv = buffer.slice(0, 12);
  const ciphertext = buffer.slice(12);
  const key = await deriveKey(secret, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
