/**
 * @pakdam/workers — auth helpers.
 *
 * Rules enforced here (frozen contract v2.1 + built-in checklist):
 * - Ticket / token VALUES are never stored and never logged — only SHA-256
 *   hashes cross the Worker -> DO boundary and only hashes are stored.
 * - WS tickets are >= 128 bits of entropy, single-use, 60 s TTL.
 * - Catch tokens are >= 128 bits (32 uppercase hex chars, `newCatchToken`
 *   from @pakdam/shared). The old 12-char (48-bit) form is rejected by
 *   `isValidCatchToken` and must never be minted.
 * - Reconnect tokens and host tokens are SEPARATE credentials. Sending one
 *   as the other 403s. Only hashes live in the DO.
 */
import {
  WS_TICKET_TTL_MS,
  hashHostToken,
  hashReconnectToken,
  hashWsTicket,
  newId,
  randomHex,
} from '@pakdam/shared';

export { hashHostToken, hashReconnectToken, hashWsTicket };

/** A fresh 128-bit reconnect token (raw value — returned to the client once). */
export function newReconnectToken(): string {
  return randomHex(16);
}

/** A fresh 128-bit host token (raw value — returned to the client once). */
export function newHostToken(): string {
  return randomHex(16);
}

/** A fresh 6-letter invite code (A-Z0-9). Retried by the caller on collision. */
export function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const b of bytes) code += alphabet[b % alphabet.length] as string;
  return code;
}

export interface WsTicket {
  /** Raw ticket value — handed to the client ONCE, never stored, never logged. */
  ticket: string;
  ticketId: string;
  expiresAtMs: number;
}

/**
 * Mint a WS ticket. The Worker mints the VALUE; only its SHA-256 hash is
 * ever sent to the DO (see `register-ticket`). A ticket issued for one seat
 * revokes any other unredeemed ticket for that seat (enforced in the DO).
 */
export function newWsTicket(nowMs: number = Date.now()): WsTicket {
  return {
    ticket: randomHex(32),
    ticketId: newId(),
    expiresAtMs: nowMs + WS_TICKET_TTL_MS,
  };
}

/** SHA-256 hex of a WS ticket value — the only form that crosses Worker -> DO. */
export async function hashTicketValue(ticket: string): Promise<string> {
  return hashWsTicket(ticket);
}

/** Does this raw reconnect token match the stored hash for the seat? */
export async function verifyReconnectToken(
  rawToken: string | undefined | null,
  storedHash: string,
): Promise<boolean> {
  if (!rawToken) return false;
  return (await hashReconnectToken(rawToken)) === storedHash;
}

/** Does this raw host token match the stored hash for the seat? */
export async function verifyHostToken(
  rawToken: string | undefined | null,
  storedHash: string,
): Promise<boolean> {
  if (!rawToken) return false;
  return (await hashHostToken(rawToken)) === storedHash;
}
