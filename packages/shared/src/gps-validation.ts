/**
 * GPS VALIDATION — server-side fix checks (founder-approved final
 * stack, 2026-11-17). Every location fix the Durable Object accepts
 * passes through `validateFix` before it can move a player, count
 * outside-zone seconds, or confirm a catch.
 *
 * Checks, in order:
 *   1. Shape/range — lat/lng in range, accuracy finite and > 0,
 *      timestamp a real ISO date. Malformed fixes are REJECTED
 *      (they are never a player's fault to punish — they are dropped).
 *   2. Timestamp — a fix from the future (beyond clock skew) or
 *      older than the staleness limit is REJECTED as stale/future
 *      (a replayed or mis-clocked fix must not move a player).
 *   3. Duplicate — byte-identical to the previous accepted fix
 *      (same lat/lng/accuracy/at) is REJECTED as a duplicate update
 *      (retransmits and double-sends must not double-count).
 *   4. Accuracy tier — good/fair/poor via `classifyAccuracy`
 *      (CALIBRATION_OPEN tiers). Poor accuracy is NEVER a rejection
 *      and NEVER cheating evidence (HNT-034): it only warns, and the
 *      outside-zone countdown PAUSES while the fix is poor (founder
 *      decision, docs/DECISIONS.md).
 *   5. Impossible movement — the speed from the previous accepted
 *      fix exceeds the plausible maximum. This WARNS, never rejects:
 *      indoor GPS drift and urban multipath routinely produce
 *      jumps, and an honest player must never be ejected for them.
 *      The warning is a flag for the host, not a punishment.
 *   6. Server-side proximity — `verifyCatchProximity` checks the
 *      hunter/runner distance against the plausibility radius. It
 *      is PLAUSIBILITY ONLY, never proof (HNT-053): a catch is
 *      confirmed by the QR/manual flow, never by GPS alone.
 *
 * THRESHOLDS ARE CALIBRATION OPEN — generous placeholders, not
 * measured facts. `MAX_PLAUSIBLE_SPEED_MPS`, `CLOCK_SKEW_MS` and
 * `STALE_FIX_MS` below must be replaced by field-test measurements
 * before the external pilot (see docs/DECISIONS.md, calibration
 * section). The code is written so a threshold change is one
 * constant, and so a warn never becomes a punishment by accident:
 * only `reject` verdicts drop a fix, and only malformed / future /
 * stale / duplicate fixes are rejected.
 */
import { CALIBRATION_OPEN } from './calibration.js';
import { ZONE_AUTO_CENTRE_MAX_ACCURACY_M } from './types.js';
import { classifyAccuracy } from './validation.js';
import type { LocationQuality } from './types.js';
import { haversineMeters } from './validation.js';

/** Generous placeholder: 30 m/s ≈ 108 km/h. A player on foot cannot
 *  sustain it; a car can. CALIBRATION OPEN — measure in the field
 *  (urban multipath routinely reports 10–20 m/s jumps for a
 *  stationary phone). Warn only, never reject. */
export const MAX_PLAUSIBLE_SPEED_MPS = 30;
/** Clock skew tolerated between a player's phone clock and the
 *  server clock. CALIBRATION OPEN — 5 min is generous on purpose. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** A fix older than this on arrival is stale. CALIBRATION OPEN —
 *  60 s matches the disconnect-grace placeholder. */
export const STALE_FIX_MS = 60 * 1000;

export type FixVerdict = 'accept' | 'warn' | 'reject';

export interface FixValidation {
  verdict: FixVerdict;
  quality: LocationQuality;
  /** Human-readable reasons, in order found. Empty when accepted. */
  issues: string[];
  /** Speed from the previous fix, when computable (m/s). */
  speedMps: number | null;
}

export interface PreviousFix {
  lat: number;
  lng: number;
  accuracyMeters: number;
  at: string;
}

/** Validate one fix. `now` is the server time (defaults to now);
 *  `previous` is the player's last ACCEPTED fix, when one exists.
 *  The fix shape is minimal on purpose (lat/lng/accuracy/at) so
 *  both the wire shape (capturedAt) and the stored LocationFix can
 *  be validated through the same function. */
export function validateFix(
  fix: { lat: number; lng: number; accuracyMeters: number; at: string },
  opts: { now?: Date; previous?: PreviousFix | null } = {},
): FixValidation {
  const now = opts.now ?? new Date();
  const issues: string[] = [];
  const quality: LocationQuality = classifyAccuracy(fix.accuracyMeters, CALIBRATION_OPEN);

  // 1. Shape/range — reject malformed fixes outright.
  if (!Number.isFinite(fix.lat) || fix.lat < -90 || fix.lat > 90) {
    return { verdict: 'reject', quality: 'unknown', issues: ['latitude out of range (-90–90)'], speedMps: null };
  }
  if (!Number.isFinite(fix.lng) || fix.lng < -180 || fix.lng > 180) {
    return { verdict: 'reject', quality: 'unknown', issues: ['longitude out of range (-180–180)'], speedMps: null };
  }
  if (!Number.isFinite(fix.accuracyMeters) || fix.accuracyMeters <= 0) {
    return { verdict: 'reject', quality: 'unknown', issues: ['accuracy must be a positive finite number of metres'], speedMps: null };
  }
  const atMs = Date.parse(fix.at);
  if (Number.isNaN(atMs)) {
    return { verdict: 'reject', quality: 'unknown', issues: ['timestamp is not a valid date-time'], speedMps: null };
  }

  // 2. Timestamp — future beyond skew, or stale on arrival.
  if (atMs > now.getTime() + CLOCK_SKEW_MS) {
    return { verdict: 'reject', quality, issues: [`fix timestamp is ${(Math.round((atMs - now.getTime()) / 1000))} s in the future — clock skew or replay`], speedMps: null };
  }
  if (now.getTime() - atMs > STALE_FIX_MS) {
    return { verdict: 'reject', quality, issues: [`fix is ${Math.round((now.getTime() - atMs) / 1000)} s old — stale location`], speedMps: null };
  }

  const prev = opts.previous ?? null;
  // 3. Duplicate — identical to the previous accepted fix.
  if (prev && prev.lat === fix.lat && prev.lng === fix.lng && prev.accuracyMeters === fix.accuracyMeters && prev.at === fix.at) {
    return { verdict: 'reject', quality, issues: ['duplicate of the previous fix — retransmit ignored'], speedMps: 0 };
  }

  // 4. Accuracy tier — poor accuracy warns; it never rejects.
  if (quality === 'poor') {
    issues.push(`GPS accuracy is poor (±${Math.round(fix.accuracyMeters)} m) — treat the position as approximate`);
  }

  // 5. Impossible movement — warn only, never reject.
  let speedMps: number | null = null;
  if (prev) {
    const prevMs = Date.parse(prev.at);
    const dtSeconds = (atMs - prevMs) / 1000;
    if (dtSeconds > 0) {
      const dist = haversineMeters(prev.lat, prev.lng, fix.lat, fix.lng);
      speedMps = dist / dtSeconds;
      if (speedMps > MAX_PLAUSIBLE_SPEED_MPS) {
        issues.push(`impossible movement: ${Math.round(speedMps)} m/s from the previous fix (limit ${MAX_PLAUSIBLE_SPEED_MPS} m/s) — likely GPS jump, not a real move`);
      }
    }
  }

  return { verdict: issues.length ? 'warn' : 'accept', quality, issues, speedMps };
}

/** Server-side proximity verification for a catch: is the hunter
 *  plausibly near the runner? Returns the distance and whether it
 *  is within the plausibility radius. PLAUSIBILITY ONLY — a catch
 *  is confirmed by the QR/manual flow, never by this check, and a
 *  failed check never rejects a catch on its own (it flags it for
 *  the host). Threshold: CALIBRATION_OPEN `catchProximityPlausibilityM`. */
export function verifyCatchProximity(
  hunter: { lat: number; lng: number },
  runner: { lat: number; lng: number },
): { distanceMeters: number; plausible: boolean; plausibilityRadiusM: number } {
  const distanceMeters = haversineMeters(hunter.lat, hunter.lng, runner.lat, runner.lng);
  const plausibilityRadiusM = CALIBRATION_OPEN.catchProximityPlausibilityM;
  return { distanceMeters, plausible: distanceMeters <= plausibilityRadiusM, plausibilityRadiusM };
}

/**
 * Zone auto-centre rule (founder, 2026-11-17 — FIXED, not
 * calibration): only a GPS fix within ±50 m
 * (ZONE_AUTO_CENTRE_MAX_ACCURACY_M) may auto-centre the play zone.
 * A coarser fix NEVER places or moves the zone — the host places it
 * by hand instead (tap the map / drag the centre pin). A missing,
 * non-finite or non-positive accuracy is never good enough.
 */
export function canAutoCentreZone(accuracyMeters: number | null | undefined): boolean {
  return typeof accuracyMeters === 'number' &&
    Number.isFinite(accuracyMeters) &&
    accuracyMeters > 0 &&
    accuracyMeters <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M;
}

/** Re-exported for consumers that need the distance helper without
 *  importing the whole validation module. */
export { haversineMeters };
