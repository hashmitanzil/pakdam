/**
 * Pakdam GPS rules — fix validation, the ±50 m auto-centre / send rule,
 * fix-quality handling, freshness labels, catch-proximity plausibility.
 *
 * Foundational rules:
 *  - Only fixes accurate to ±50 m or better are ever sent.
 *  - Poor accuracy is warned, never treated as cheating, never a rejection.
 *  - GPS is supporting evidence for a catch only — never proof, never a
 *    rejection on its own.
 *  - Foreground-only: location stops when the tab hides.
 */
import {
  CLOCK_SKEW_MS,
  LOCATION_FRESHNESS_SECONDS,
  MAX_PLAUSIBLE_SPEED_MPS,
  STALE_FIX_MS,
  ZONE_AUTO_CENTRE_MAX_ACCURACY_M,
  CATCH_PROXIMITY_PLAUSIBILITY_M,
} from './calibration.js';
import type { GeoPoint, LocationFix, LocationQuality } from './types.js';
import { classifyAccuracy } from './validation.js';

// ---------------------------------------------------------------------------
// Fix validation
// ---------------------------------------------------------------------------

export interface FixValidationResult {
  /** False when an `errors` entry exists; warnings never fail a fix. */
  ok: boolean;
  /** Hard rejections: shape/range, bad timestamp, clock skew, stale, exact duplicate. */
  errors: string[];
  /** Soft warnings: poor accuracy, impossible movement. Never a rejection. */
  warnings: string[];
  /** Quality tier of the fix (null when the fix is rejected). */
  quality: LocationQuality | null;
  /**
   * Error code for a rejection (null when `ok`): malformed shape/range,
   * bad timestamp, clock skew and exact duplicates are VALIDATION_FAILED;
   * only a fix that arrived too old is STALE_LOCATION. Callers must use
   * this, never hard-code one code for every failure — a malformed fix
   * is not a stale one, and clients branch on the code.
   */
  code: 'VALIDATION_FAILED' | 'STALE_LOCATION' | null;
}

/**
 * Validate one fix (`validateFix`).
 * Rejects: bad shape/range (lat ±90, lng ±180, accuracy > 0 finite, valid
 * timestamp), timestamp > 5 min in the future (clock skew / replay), a fix
 * > 60 s old on arrival, an exact duplicate of the previous accepted fix.
 * Warns only: poor accuracy, impossible movement (> 30 m/s from the previous
 * fix). `nowMs` defaults to Date.now(); pass it explicitly in tests.
 */
export function validateFix(
  fix: unknown,
  previousFix?: LocationFix | null,
  nowMs: number = Date.now(),
): FixValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof fix !== 'object' || fix === null) {
    return { ok: false, errors: ['fix must be an object'], warnings, quality: null, code: 'VALIDATION_FAILED' };
  }
  const f = fix as Partial<LocationFix>;
  if (
    typeof f.lat !== 'number' ||
    !Number.isFinite(f.lat) ||
    f.lat < -90 ||
    f.lat > 90 ||
    typeof f.lng !== 'number' ||
    !Number.isFinite(f.lng) ||
    f.lng < -180 ||
    f.lng > 180
  ) {
    errors.push('fix latitude must be ±90 and longitude ±180');
  }
  if (typeof f.accuracyMeters !== 'number' || !Number.isFinite(f.accuracyMeters) || f.accuracyMeters <= 0) {
    errors.push('fix accuracyMeters must be a finite number greater than 0');
  }
  if (typeof f.timestampMs !== 'number' || !Number.isFinite(f.timestampMs)) {
    errors.push('fix timestampMs must be a finite epoch-milliseconds number');
  }
  if (errors.length > 0) {
    return { ok: false, errors, warnings, quality: null, code: 'VALIDATION_FAILED' };
  }

  const timestampMs = f.timestampMs as number;
  // A timestamp too far in the future is a validity problem (clock skew /
  // replay), not staleness; only a fix that arrived too old is stale.
  if (timestampMs - nowMs > CLOCK_SKEW_MS) {
    return {
      ok: false,
      errors: ['fix timestamp is too far in the future (clock skew or replay)'],
      warnings,
      quality: null,
      code: 'VALIDATION_FAILED',
    };
  }
  if (nowMs - timestampMs > STALE_FIX_MS) {
    return {
      ok: false,
      errors: ['fix is too old on arrival'],
      warnings,
      quality: null,
      code: 'STALE_LOCATION',
    };
  }

  if (
    previousFix !== null &&
    previousFix !== undefined &&
    f.lat === previousFix.lat &&
    f.lng === previousFix.lng &&
    f.accuracyMeters === previousFix.accuracyMeters &&
    timestampMs === previousFix.timestampMs
  ) {
    errors.push('fix is an exact duplicate of the previous accepted fix');
    return { ok: false, errors, warnings, quality: null, code: 'VALIDATION_FAILED' };
  }

  const accuracyMeters = f.accuracyMeters as number;
  const quality = classifyAccuracy(accuracyMeters);
  if (quality === 'poor') {
    warnings.push('poor GPS accuracy — warned, never treated as cheating');
  }
  if (previousFix !== null && previousFix !== undefined) {
    const dtSeconds = Math.max(0, (timestampMs - previousFix.timestampMs) / 1000);
    if (dtSeconds > 0) {
      const speed = haversineMeters(previousFix, { lat: f.lat as number, lng: f.lng as number }) / dtSeconds;
      if (speed > MAX_PLAUSIBLE_SPEED_MPS) {
        warnings.push('impossible movement from the previous fix — warned, never rejected');
      }
    }
  }
  return { ok: true, errors, warnings, quality, code: null };
}

// ---------------------------------------------------------------------------
// The ±50 m rule
// ---------------------------------------------------------------------------

/**
 * Can the zone be auto-centred on this fix? Never on a fix worse than ±50 m —
 * the host places the zone by hand instead.
 */
export function canAutoCentreZone(fix: LocationFix): boolean {
  return fix.accuracyMeters <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M;
}

/**
 * May this fix be sent at all? Same ±50 m rule: a fix worse than that is
 * never sent and the UI says so plainly.
 */
export function isFixSendable(fix: LocationFix): boolean {
  return canAutoCentreZone(fix);
}

// ---------------------------------------------------------------------------
// Freshness — "Location never reported"
// ---------------------------------------------------------------------------

/** Per-player location status for the snapshot: 'known' only while a fresh foreground fix is held. */
export type LocationStatus = 'known' | 'unknown';

/**
 * Location status from the last fix timestamp. `lastFixAtMs` null means the
 * player has never reported a fix. Freshness window is OPEN calibration (30 s).
 */
export function locationStatusForPlayer(lastFixAtMs: number | null, nowMs: number = Date.now()): LocationStatus {
  if (lastFixAtMs === null) return 'unknown';
  return nowMs - lastFixAtMs <= LOCATION_FRESHNESS_SECONDS * 1000 ? 'known' : 'unknown';
}

/**
 * Plain-words freshness label for a roster row.
 * - null → "Location never reported"
 * - stale → "Location unknown"
 * - fresh → "Last fix 0:20 ago"
 */
export function locationFreshnessLabel(lastFixAtMs: number | null, nowMs: number = Date.now()): string {
  if (lastFixAtMs === null) return 'Location never reported';
  const ageSeconds = Math.max(0, Math.floor((nowMs - lastFixAtMs) / 1000));
  if (ageSeconds > LOCATION_FRESHNESS_SECONDS) return 'Location unknown';
  return `Last fix ${formatAgeLabel(ageSeconds)} ago`;
}

/** Format an age in seconds as `m:ss` (e.g. 20 → "0:20", 125 → "2:05"). */
export function formatAgeLabel(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Catch proximity + haversine
// ---------------------------------------------------------------------------

/**
 * Catch-proximity plausibility: hunter↔runner distance vs 15 m (OPEN).
 * Plausibility only — never proof, and a failed check never rejects a catch
 * on its own. Absent/stale GPS is "no GPS evidence", never negative evidence.
 */
export function verifyCatchProximity(
  hunterFix: LocationFix,
  runnerFix: LocationFix,
): { distanceMeters: number; plausible: boolean } {
  const distanceMeters = haversineMeters(hunterFix, runnerFix);
  return { distanceMeters, plausible: distanceMeters <= CATCH_PROXIMITY_PLAUSIBILITY_M };
}

/** Great-circle distance in metres between two points. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const earthRadiusM = 6_371_000;
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLng * sinLng;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}
