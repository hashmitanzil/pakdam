/**
 * `teammate.fix` — performance roadmap R3 (v29 fix round M4).
 *
 * The server fans a teammate's fix out to their teammates only, as
 * `{ playerId, lat, lng, accuracyMeters, timestampMs }`, the moment
 * the fix lands — a fix-broadcast costs 0 extra Durable Objects
 * requests (only inbound messages and alarm invocations count), so it
 * is strictly fresher than any periodic re-fetch. The client applies
 * the fix straight into the teammate-dot map: no snapshot re-fetch.
 * The R1 30 s safety valve stays as the safety net (a dropped
 * broadcast is corrected within 30 s by the next valve re-fetch).
 *
 * Pure merge, unit-tested: an invalid payload (bad shape, non-finite
 * coordinates, non-positive accuracy, missing timestamp) or the
 * viewer's OWN playerId (the server never sends it — defence in
 * depth, the viewer's own fix comes from local GPS) returns the input
 * map unchanged; a valid teammate fix returns a new map with that one
 * entry replaced. Membership gating (is this playerId actually a
 * teammate?) lives with the caller, which holds the live teammate
 * list — this helper only validates shape.
 */
import type { LocationFix } from '@pakdam/shared';

export interface TeammateFixPayload {
  playerId: unknown;
  lat: unknown;
  lng: unknown;
  accuracyMeters: unknown;
  timestampMs: unknown;
}

/** Merge one `teammate.fix` payload into the teammate-dot map (or return the map unchanged). */
export function mergeTeammateFix(
  fixes: Record<string, LocationFix>,
  payload: TeammateFixPayload | null | undefined,
  myPlayerId: string,
): Record<string, LocationFix> {
  if (!payload || typeof payload !== 'object') return fixes;
  const { playerId, lat, lng, accuracyMeters, timestampMs } = payload;
  if (typeof playerId !== 'string' || playerId.length === 0) return fixes;
  if (playerId === myPlayerId) return fixes;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return fixes;
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return fixes;
  if (typeof accuracyMeters !== 'number' || !Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
    return fixes;
  }
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return fixes;
  return {
    ...fixes,
    [playerId]: { lat, lng, accuracyMeters, timestampMs },
  };
}
