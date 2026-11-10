/**
 * Cryptographic security utilities for PalletTrack Phase 2 Authentication.
 * Uses Web Crypto API standard (available in both Cloudflare Workers & Node.js).
 */

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH = 'SHA-256';
const SALT_BYTE_LENGTH = 16;
const TOKEN_BYTE_LENGTH = 32;

function bufToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBuf(hex: string): Uint8Array {
  const cleanHex = hex.trim();
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Derives a PBKDF2-HMAC-SHA256 hash for a 4-digit PIN.
 */
export async function hashPin(
  pin: string,
  existingSaltHex?: string
): Promise<{ hash: string; salt: string }> {
  const enc = new TextEncoder();
  const saltBytes = existingSaltHex
    ? hexToBuf(existingSaltHex)
    : crypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin.trim()),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    256
  );

  return {
    hash: bufToHex(derivedBits),
    salt: bufToHex(saltBytes),
  };
}

/**
 * Validates entered PIN against stored PBKDF2 hash using constant-time comparison.
 */
export async function verifyPin(
  enteredPin: string,
  storedHash: string,
  storedSalt: string
): Promise<boolean> {
  if (!enteredPin || !storedHash || !storedSalt) return false;
  const { hash } = await hashPin(enteredPin, storedSalt);
  return timingSafeEqual(hash, storedHash);
}

/**
 * Generates a cryptographically random session token (32 bytes / 64 hex characters).
 */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTE_LENGTH));
  return bufToHex(bytes);
}

/**
 * Computes SHA-256 hash of a session token for safe storage in the database.
 */
export async function hashSessionToken(token: string): Promise<string> {
  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(token.trim()));
  return bufToHex(hashBuffer);
}
