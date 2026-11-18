import type { Player, PlayerView, Room } from '@pakdam/shared';
/**
 * Authorised snapshot (HNT-038): a client receives ONLY its own location
 * and coarse pings. Hidden exact opponent coordinates NEVER leave the server.
 * Recovery snapshots contain NO raw coordinates and NO pending pings (HNT-120).
 *
 * SECURITY (QA 2026-11-17, SEC-01): players are returned as PlayerView —
 * the reconnect-token hash is stripped. An earlier version spread the full
 * Player (including `reconnectTokenHash`) into every snapshot, so the
 * DO `get-state` op handed every seat's token hash to any caller that
 * named a playerId. The hash alone does not log anyone in (the raw token
 * is a separate UUID), but it is a credential-adjacent secret that must
 * never leave the server, and it also let any caller enumerate the roster.
 */
export interface AuthorisedSnapshot { room: Room; players: PlayerView[]; version: number }
export function authorisedSnapshot(room: Room, players: Player[], requestingPlayerId: string): AuthorisedSnapshot {
  // Players carry lastFixAt + locationQuality only — no lat/lng fields exist on Player.
  // Strip the reconnect-token hash: it is never part of a client payload (17 §3.3).
  // ROLE SECRECY (QA 2026-11-17, MP-ROLE-LEAK): a seat sees its OWN
  // matchRole/team only. Every other seat's role is null — the "tap to
  // find out, no peeking" rule is enforced on the wire, not just in the
  // UI. (The host knows its own pick from the lobby; catch parties are
  // named in activeCatches, and team-scoped broadcasts are filtered
  // server-side, so nothing the client legitimately needs is lost.)
  return { room, players: players.map((p) => { const { reconnectTokenHash: _hash, ...view } = p; return p.playerId === requestingPlayerId ? view : { ...view, matchRole: null, team: null }; }), version: room.version };
}
