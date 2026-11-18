import type { CatchEvent, LocationFix } from '@pakdam/shared';
import { sha256Hex, randomHex } from '@pakdam/shared';
export interface CatchToken { raw: string; hash: string; expiresAtMs: number }
export function issueCatchToken(catchId: string, ttlSeconds: number, nowMs: number): CatchToken {
  // 12-char one-time token. The QR encodes it — there is NO manual code
  // in Pakdam: the token lives only inside the Runner's QR, and the
  // Hunter's scan is what proves the two players were together.
  const raw = randomHex(6).toUpperCase();
  const hash = sha256Hex(`${catchId}:${raw}`);
  return { raw, hash, expiresAtMs: nowMs + ttlSeconds * 1000 };
}
export function verifyCatchToken(catchId: string, raw: string, hash: string): boolean {
  return sha256Hex(`${catchId}:${raw}`) === hash;
}
/**
 * GPS is supporting evidence ONLY. A catch is final ONLY when the
 * Runner has agreed (tapped "Got tagged" and shown their QR) AND the
 * Hunter's scan completes the claim — or, when the camera is
 * unavailable, the Runner confirms themself manually. Timeout is NOT
 * confirmation. Absent/stale GPS is "no GPS evidence", never negative
 * evidence (HNT-053).
 */
export function gpsEvidenceForCatch(fix: LocationFix | null, nowMs: number, freshnessMs: number): 'present' | 'absent' | 'stale' {
  if (!fix) return 'absent';
  return nowMs - new Date(fix.receivedAt).getTime() <= freshnessMs ? 'present' : 'stale';
}
/** The tag happens IN PERSON first — the QR only proves/confirms it.
 *  Exact sequence (founder, 2026-11-17): Hunter tags the Runner in
 *  person → Runner taps "Got tagged" → their QR opens → Hunter scans
 *  it → the scan completes the claim (hunterId + runnerId + time are
 *  already on the event; confirmedAt is the scan time). Fallback when
 *  the camera is unavailable: the Runner confirms themself manually
 *  (dialogue box) — no code, no QR needed. `resolution` records HOW
 *  the claim completed ('qr-scan' | 'manual-confirm'); null when the
 *  caller does not say (e.g. a host confirming a disputed catch). */
export function resolveCatch(c: CatchEvent, action: 'confirm' | 'dispute', nowIso: string, resolution?: 'qr-scan' | 'manual-confirm'): CatchEvent {
  if (c.state !== 'awaiting-confirmation' && c.state !== 'requested') throw new Error('INVALID_STATE: catch is not awaiting confirmation');
  if (action === 'confirm') return { ...c, state: 'confirmed', confirmedAt: nowIso, resolution: resolution ?? null };
  return { ...c, state: 'disputed', disputedAt: nowIso, resolution: 'neutral-review-required' };
}
export function expireCatch(c: CatchEvent): CatchEvent {
  if (c.state === 'confirmed' || c.state === 'disputed') return c;
  return { ...c, state: 'expired' };
}
