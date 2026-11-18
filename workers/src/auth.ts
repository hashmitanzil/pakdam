import { sha256Hex, randomHex } from '@pakdam/shared';
import type { WsTicketPurpose } from '@pakdam/shared';
/**
 * Short-lived, single-use WebSocket ticket issued over HTTPS (17 §2.5, §3.1).
 * The ticket travels ONLY in the handshake query string
 *   wss://<api-host>/v1/rooms/{roomId}/ws?ticket=<ticket>
 * and is consumed the moment the handshake succeeds. The `hello` message
 * carries NO credential. The ONLY WS message that carries a ticket is
 * `auth.refresh` (renewal, 17 §3.2).
 *
 * Ticket VALUES are never logged and never stored — only their SHA-256
 * hash and a `ticketId` (uuid). Logs may carry the `ticketId` only.
 * `wsTicketTtlSeconds` is OPEN calibration (17 §7); the TTL is a parameter
 * supplied by the issuer, never a fixed number in this file.
 */
export interface WsTicket { ticket: string; hash: string; roomId: string; playerId: string; expiresAtMs: number }
export interface WsTicketRecord {
  ticketId: string; hash: string; roomId: string; playerId: string;
  purpose: WsTicketPurpose; issuedAtMs: number; expiresAtMs: number;
  status: 'valid' | 'redeemed' | 'revoked' | 'expired';
}
export interface TicketIssue { ticket: string; ticketId: string; expiresAtMs: number }
export type TicketRedeemResult =
  | { ok: true; ticketId: string; purpose: WsTicketPurpose }
  | { ok: false; code: 'TICKET_INVALID' | 'TICKET_REUSED' | 'TICKET_EXPIRED' };

export function issueWsTicket(roomId: string, playerId: string, ttlMs: number, nowMs: number): WsTicket {
  const ticket = randomHex(16);
  return { ticket, hash: sha256Hex(ticket), roomId, playerId, expiresAtMs: nowMs + ttlMs };
}
/** Pure hash/expiry check. This alone does NOT enforce single-use — the
 *  WsTicketStore below is the single-use mechanism; use it on upgrade. */
export function verifyWsTicket(t: WsTicket, presented: string, nowMs: number): boolean {
  if (nowMs > t.expiresAtMs) return false;
  return sha256Hex(presented) === t.hash;
}

/** Single-use ticket store (in-memory; the DO owns one per room in
 *  production — persistence of ticket records is a deployment concern,
 *  not part of this contract). */
export class WsTicketStore {
  private tickets = new Map<string, WsTicketRecord>(); // keyed by hash only

  issue(roomId: string, playerId: string, purpose: WsTicketPurpose, ttlMs: number, nowMs: number): TicketIssue {
    // Issuing a new ticket invalidates any other UNREDEEMED ticket for the
    // same seat (17 §2.5). It does NOT invalidate an already-connected socket.
    for (const rec of this.tickets.values()) {
      if (rec.roomId === roomId && rec.playerId === playerId && rec.status === 'valid') {
        rec.status = 'revoked';
      }
    }
    const ticket = randomHex(16);
    const rec: WsTicketRecord = {
      ticketId: randomHex(8), hash: sha256Hex(ticket), roomId, playerId,
      purpose, issuedAtMs: nowMs, expiresAtMs: nowMs + ttlMs, status: 'valid',
    };
    this.tickets.set(rec.hash, rec);
    return { ticket, ticketId: rec.ticketId, expiresAtMs: rec.expiresAtMs };
  }

  /** Consume a ticket on handshake. A second use of the same ticket is
   *  TICKET_REUSED; a ticket for another room/seat (or malformed) is
   *  TICKET_INVALID; a past-TTL ticket is TICKET_EXPIRED. */
  redeem(presented: string, roomId: string, playerId: string, nowMs: number): TicketRedeemResult {
    const rec = this.tickets.get(sha256Hex(presented));
    if (!rec || rec.roomId !== roomId || rec.playerId !== playerId) {
      return { ok: false, code: 'TICKET_INVALID' };
    }
    if (rec.status === 'redeemed') return { ok: false, code: 'TICKET_REUSED' };
    if (rec.status === 'revoked') return { ok: false, code: 'TICKET_INVALID' };
    if (nowMs > rec.expiresAtMs || rec.status === 'expired') {
      rec.status = 'expired';
      return { ok: false, code: 'TICKET_EXPIRED' };
    }
    rec.status = 'redeemed';
    return { ok: true, ticketId: rec.ticketId, purpose: rec.purpose };
  }

  /** Revoke all unredeemed tickets for a seat (17 §2.6). Returns the count
   *  revoked — counts only, no ticket values. */
  revokeSeat(roomId: string, playerId: string): number {
    let n = 0;
    for (const rec of this.tickets.values()) {
      if (rec.roomId === roomId && rec.playerId === playerId && rec.status === 'valid') {
        rec.status = 'revoked'; n++;
      }
    }
    return n;
  }

  /** Read-only lookup for the WS upgrade: resolve a presented ticket
   *  to its room + seat WITHOUT consuming it (the upgrade handler
   *  then redeems it via `redeem` with the resolved seat). Returns
   *  null for an unknown ticket. Never logs the ticket value. */
  peek(presented: string): { roomId: string; playerId: string; purpose: WsTicketPurpose; expiresAtMs: number } | null {
    const rec = this.tickets.get(sha256Hex(presented));
    if (!rec) return null;
    return { roomId: rec.roomId, playerId: rec.playerId, purpose: rec.purpose, expiresAtMs: rec.expiresAtMs };
  }

  /** Server-side lookup by ticketId (Worker → DO registration):
   *  returns the stored record (hash included — server-side only,
   *  never sent to a client) or null. Lets the Worker register the
   *  ticket's hash with the Durable Object so the DO can validate
   *  `auth.refresh` renewals itself (SEC-11). */
  recordFor(ticketId: string): WsTicketRecord | null {
    for (const rec of this.tickets.values()) {
      if (rec.ticketId === ticketId) return rec;
    }
    return null;
  }

  /** The only ticket reference that may appear in a log. */
  static logRef(ticketId: string): string {
    return `ticketId=${ticketId}`;
  }
}
