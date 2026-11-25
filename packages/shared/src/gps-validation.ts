/**
 * Pakdam GPS rules — fix validation, the ±50 m auto-centre / send rule,
 * fix-quality handling, freshness labels, catch-proximity plausibility.
 *
 * Foundational rules:
 *  - Only fixes accurate to ±50 m or better are ever sent.
 *  - Poor accuracy is warned, never treated as cheating, never a rejection.
 *  - GPS evidence (`gpsEvidence`) is supporting only — never proof. But a
 *    tag itself is PHYSICAL: `confirmCatch` / `requestCatch` reject when
 *    either phone has no recent fix or the two are more than
 *    CATCH_MAX_DISTANCE_METERS apart (see @pakdam/engine `catch.ts`).
 *  - Foreground-only: location stops when the tab hides.
 */
import {
  CLOCK_SKEW_MS,
  EARTH_RADIUS_M,
  GPS_ANTI_CHEAT_DEFAULTS,
  LOCATION_FRESHNESS_SECONDS,
  MAX_PLAUSIBLE_SPEED_MPS,
  STALE_FIX_MS,
  ZONE_AUTO_CENTRE_MAX_ACCURACY_M,
  CATCH_PROXIMITY_PLAUSIBILITY_M,
} from './calibration.js';

/**
 * Upper bound on fix accuracy: a fix worse than ±1000 m is rejected
 * outright. The client-side ±50 m send rule is unenforced server-side
 * (the server only warns on poor accuracy), so without a bound a
 * kilometre-wide fix could anchor a catch, a ping, or a zone decision.
 * 1000 m is a validity bound, not a quality bar — the ±50 m send rule
 * and the accuracy tiers still decide what is usable.
 */
export const MAX_FIX_ACCURACY_METERS = 1000;
import type { GeoPoint, GpsAntiCheatConfig, LocationFix, LocationQuality } from './types.js';
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
  code: 'VALIDATION_FAILED' | 'STALE_LOCATION' | 'CLOCK_SKEW' | null;
}

/**
 * Validate one fix (`validateFix`).
 * Rejects: bad shape/range (lat ±90, lng ±180, accuracy > 0 finite, valid
 * timestamp), accuracy worse than MAX_FIX_ACCURACY_METERS (±1000 m),
 * timestamp > 5 min in the future (clock skew / replay), a fix
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
  } else if (f.accuracyMeters > MAX_FIX_ACCURACY_METERS) {
    errors.push(`fix accuracyMeters must be at most ${MAX_FIX_ACCURACY_METERS} m`);
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
  // v34 (Diya R2-6) — it gets its OWN code, CLOCK_SKEW, not the generic
  // VALIDATION_FAILED: the client can branch on the code and tell the
  // player "your phone clock is wrong" instead of failing silently.
  // (A phone BEHIND still trips STALE_LOCATION below — the server cannot
  // tell skew from genuine staleness on one fix; the error envelope
  // already carries serverTs, so the client can spot a stable offset
  // across repeated STALE_LOCATION rejections. Receipt-time validation
  // is the open founder call, not built here.)
  if (timestampMs - nowMs > CLOCK_SKEW_MS) {
    return {
      ok: false,
      errors: ['fix timestamp is too far in the future (clock skew or replay)'],
      warnings,
      quality: null,
      code: 'CLOCK_SKEW',
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
// GPS anti-cheat — speed + teleport only (Gap 1, reliability spec §2)
// ---------------------------------------------------------------------------

/** Effective anti-cheat settings: room overrides over the defaults. */
export type ResolvedGpsAntiCheatConfig = {
  enabled: boolean;
  warnOnly: boolean;
  action: 'warn' | 'eject';
  maxSpeedMs: number;
  burstMaxMs: number;
  burstWindowMs: number;
  teleportMaxGapM: number;
  teleportMaxGapMs: number;
  violationThreshold: number;
};

/** Merge a room's `gpsAntiCheat` overrides onto `GPS_ANTI_CHEAT_DEFAULTS`. */
export function resolveGpsAntiCheatConfig(
  overrides?: GpsAntiCheatConfig | null,
): ResolvedGpsAntiCheatConfig {
  const o = overrides ?? {};
  return {
    enabled: o.enabled ?? GPS_ANTI_CHEAT_DEFAULTS.enabled,
    warnOnly: o.warnOnly ?? GPS_ANTI_CHEAT_DEFAULTS.warnOnly,
    action: o.action ?? GPS_ANTI_CHEAT_DEFAULTS.action,
    maxSpeedMs: o.maxSpeedMs ?? GPS_ANTI_CHEAT_DEFAULTS.maxSpeedMs,
    burstMaxMs: o.burstMaxMs ?? GPS_ANTI_CHEAT_DEFAULTS.burstMaxMs,
    burstWindowMs: o.burstWindowMs ?? GPS_ANTI_CHEAT_DEFAULTS.burstWindowMs,
    teleportMaxGapM: o.teleportMaxGapM ?? GPS_ANTI_CHEAT_DEFAULTS.teleportMaxGapM,
    teleportMaxGapMs: o.teleportMaxGapMs ?? GPS_ANTI_CHEAT_DEFAULTS.teleportMaxGapMs,
    violationThreshold:
      o.violationThreshold ?? GPS_ANTI_CHEAT_DEFAULTS.violationThreshold,
  };
}

/** Movement between two accepted fixes (Gap 1). */
export interface FixMovement {
  /** Haversine distance / dt (0 when there is no previous fix or dt ≤ 0). */
  speedMps: number;
  /** Straight-line distance between the fixes, metres. */
  distanceM: number;
  /**
   * The dt the speed/teleport tests used, ms (0 when no previous fix).
   * v29 fix round (F3): SERVER receipt time — `currReceiptMs -
   * prevReceiptMs` — never the device timestamps. `validateFix`
   * allows device timestamps up to 5 min in the future and 60 s
   * stale, so a spoofer forging timestamps could stretch a device-dt
   * to ~360 s and defeat teleport (dt < 10 s), burst (dt ≤ 3 s) and
   * speed simultaneously. Receipt time cannot be forged that way:
   * it is stamped by the server on acceptance.
   */
  dtMs: number;
  /**
   * True when the jump exceeds the teleport threshold with dt under the
   * window (> 500 m in < 10 s by default). A single wild GPS fix can do
   * this once — the caller counts violations and only flags on 3 in
   * 5 min, never on one jump.
   */
  teleport: boolean;
}

/**
 * Speed + teleport between two consecutive ACCEPTED fixes (Gap 1).
 * Pure: no counting here — the caller (DO) counts violations in a
 * 5-min window. `validateFix` is untouched: its rejections and its
 * 30 m/s warning stay exactly as they are; the counted violation
 * starts at 50 m/s. A `null` previous fix (first fix) is never a
 * violation. dt ≤ 0 (equal / skewed timestamps) reports speed 0 —
 * the timestamp cannot support a speed claim — while the teleport
 * test still applies on distance alone.
 *
 * v29 fix round (F3) — `receipt` is the SERVER receipt time of each
 * fix (`nowMs` at acceptance / `lastFixAcceptedAtMs` for the
 * previous fix). When both receipt times are given, dt is receipt
 * dt; when omitted (pure-function callers with no server clock),
 * dt falls back to the device timestamps, exactly as before.
 * The DO ALWAYS passes receipt times — the device-timestamp path
 * exists only so the pure unit tests can call this without a clock.
 */
export function checkFixMovement(
  prev: LocationFix | null,
  curr: LocationFix,
  receipt?: { prevReceiptMs?: number | null; currReceiptMs?: number },
): FixMovement {
  if (prev === null || prev === undefined) {
    return { speedMps: 0, distanceM: 0, dtMs: 0, teleport: false };
  }
  const distanceM = haversineMeters(prev, curr);
  const dtMs =
    receipt !== undefined &&
    typeof receipt.prevReceiptMs === 'number' &&
    typeof receipt.currReceiptMs === 'number'
      ? receipt.currReceiptMs - receipt.prevReceiptMs
      : curr.timestampMs - prev.timestampMs;
  const speedMps = dtMs > 0 ? distanceM / (dtMs / 1000) : 0;
  const teleport =
    distanceM > GPS_ANTI_CHEAT_DEFAULTS.teleportMaxGapM &&
    dtMs < GPS_ANTI_CHEAT_DEFAULTS.teleportMaxGapMs;
  return { speedMps, distanceM, dtMs, teleport };
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
  const earthRadiusM = EARTH_RADIUS_M;
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLng * sinLng;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}
