/**
 * Pakdam hashing helpers — SHA-256 hex, token generation, ids.
 *
 * HARD RULE: ticket VALUES are never stored, never logged, never put in a URL
 * (except the single-use WS ticket in the handshake query string, the one
 * sanctioned exception). Only SHA-256 hashes are stored or compared.
 * The catch-token hash is sha256(catchId + ':' + raw).
 *
 * Web Crypto (async) only — it exists in browsers, Cloudflare Workers and
 * Node 18+. There is no synchronous SHA-256 here by design: do not hand-roll
 * one to avoid the await.
 */
import { CATCH_TOKEN_HEX_LENGTH } from './calibration.js';

/** SHA-256 hex of a UTF-8 string (lowercase, 64 chars). */
export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('SHA-256 unavailable: Web Crypto (crypto.subtle) is not present in this runtime');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex of a raw token value (reconnect token, host token, WS ticket). Store the result, never the value. */
export async function hashToken(rawToken: string): Promise<string> {
  return sha256Hex(rawToken);
}

/** SHA-256 hex of a reconnect token. Alias of hashToken — same construction, named for the call site. */
export async function hashReconnectToken(rawToken: string): Promise<string> {
  return sha256Hex(rawToken);
}

/** SHA-256 hex of a host token. Alias of hashToken — same construction, named for the call site. */
export async function hashHostToken(rawToken: string): Promise<string> {
  return sha256Hex(rawToken);
}

/** SHA-256 hex of a WS ticket value. Only the hash ever crosses the Worker→DO boundary. */
export async function hashWsTicket(rawTicket: string): Promise<string> {
  return sha256Hex(rawTicket);
}

/**
 * Catch-token hash: sha256(catchId + ':' + raw). The raw token goes to the
 * Runner only (inside their QR); the hash is what the server stores and compares.
 */
export async function catchTokenHash(catchId: string, rawToken: string): Promise<string> {
  return sha256Hex(`${catchId}:${rawToken}`);
}

/** Is this string a lowercase SHA-256 hex digest (64 chars)? */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Cryptographically random hex, lowercase, `byteLength` bytes → 2× chars.
 * Uses crypto.getRandomValues — never Math.random for tokens.
 */
export function randomHex(byteLength: number): string {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error('randomHex byteLength must be a positive integer');
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A fresh catch token: 32 uppercase hex chars = 128 bits of entropy.
 * The old 12-char (48-bit) token is NOT generated anywhere in the fresh build.
 */
export function newCatchToken(): string {
  return randomHex(CATCH_TOKEN_HEX_LENGTH / 2).toUpperCase();
}

/** A fresh id (UUID). Falls back to 128 bits of random hex when randomUUID is unavailable. */
export function newId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === 'function') {
    return uuid.call(globalThis.crypto);
  }
  return randomHex(16);
}
