/**
 * Pakdam pure validation helpers — inputs only (room code, codename, zone,
 * config values, ticket format, hello credential scan, accuracy tiers).
 * No I/O, no secrets. Every function returns data; nothing throws for bad
 * input except where noted.
 */
import {
  ACCURACY_FAIR_M,
  ACCURACY_GOOD_M,
  BALANCED_HUNTER_TABLE,
  CATCH_TOKEN_HEX_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  SUGGESTED_ZONE_RADIUS_BASE_M,
  SUGGESTED_ZONE_RADIUS_CAP_M,
  SUGGESTED_ZONE_RADIUS_PER_PLAYER_M,
  ZONE_RADIUS_MIN_M,
} from './calibration.js';
import type {
  GeoPoint,
  GeoPolygon,
  LocationQuality,
  RoomConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// Room code + codename
// ---------------------------------------------------------------------------

/** Room invite code: exactly 6 chars, A–Z0–9. */
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;

/** A 6-letter invite code is valid only in this exact form. */
export function isValidRoomCode(code: unknown): code is string {
  return typeof code === 'string' && ROOM_CODE_PATTERN.test(code);
}

/** Display name / codename: 1–30 characters after trimming. */
export function isValidDisplayName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 30;
}

/** UUID (v4-shaped) check for ids generated with crypto.randomUUID(). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

/** Latitude ±90, longitude ±180, both finite numbers. */
export function isValidGeoPoint(point: unknown): point is GeoPoint {
  if (typeof point !== 'object' || point === null) return false;
  const p = point as { lat?: unknown; lng?: unknown };
  return (
    typeof p.lat === 'number' &&
    Number.isFinite(p.lat) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lng) &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

/** A zone boundary needs ≥ 3 valid points to enclose a shape. */
export function isValidGeoPolygon(points: unknown, minPoints = 3): points is GeoPolygon {
  if (!Array.isArray(points) || points.length < minPoints) return false;
  for (const point of points) {
    if (!isValidGeoPoint(point)) return false;
  }
  return true;
}

/**
 * Validate a zone boundary. Returns issue strings (empty = valid).
 * An empty boundary is allowed — it means the zone has not been placed yet
 * (a zone is never given a default place; the host places it by hand).
 */
export function validateZoneBoundary(boundary: unknown): string[] {
  const issues: string[] = [];
  if (!Array.isArray(boundary)) {
    issues.push('zone boundary must be an array of points');
    return issues;
  }
  if (boundary.length === 0) return issues;
  if (boundary.length < 3) {
    issues.push('zone boundary needs at least 3 points to enclose a shape');
    return issues;
  }
  for (const point of boundary) {
    if (!isValidGeoPoint(point)) {
      issues.push('zone boundary contains a point outside lat ±90 / lng ±180');
      break;
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Room config
// ---------------------------------------------------------------------------

/**
 * Validate a full RoomConfig. Returns issue strings (empty = valid).
 * Enforces the ranges from the protocol map: duration 300–10800 s,
 * head start 0–1800 s, ping 0 (off) or 30–1800 s, maxPlayers 3–30,
 * hunterCount 1..maxPlayers−1, zone radius ≥ 100 m with no maximum,
 * finalSizePercent null (Auto) or 0–100, hostOnSiteConfirmed required,
 * catchConfirmationRequired forced true, and the pick invariant
 * (teamAssignment 'selected' ⇒ at least 1 and at most maxPlayers − 1
 * picked ids — the exact count is decided at start from the roster, so
 * this validator cannot demand it; 'random' ⇒ no picked ids —
 * switching to Random clears the pick).
 */
export function validateRoomConfig(config: unknown): string[] {
  const issues: string[] = [];
  if (typeof config !== 'object' || config === null) {
    return ['room config must be an object'];
  }
  const c = config as Partial<RoomConfig>;

  if (c.mode !== 'classic' && c.mode !== 'infection') {
    issues.push("mode must be 'classic' or 'infection'");
  }
  if (c.teamAssignment !== 'random' && c.teamAssignment !== 'selected') {
    issues.push("teamAssignment must be 'random' or 'selected'");
  }
  if (
    typeof c.maxPlayers !== 'number' ||
    !Number.isInteger(c.maxPlayers) ||
    c.maxPlayers < MIN_PLAYERS ||
    c.maxPlayers > MAX_PLAYERS
  ) {
    issues.push(`maxPlayers must be an integer between ${MIN_PLAYERS} and ${MAX_PLAYERS}`);
  }
  if (
    typeof c.hunterCount !== 'number' ||
    !Number.isInteger(c.hunterCount) ||
    c.hunterCount < 1 ||
    (typeof c.maxPlayers === 'number' && c.hunterCount > c.maxPlayers - 1)
  ) {
    issues.push('hunterCount must be at least 1 and less than maxPlayers');
  }
  if (
    typeof c.durationSeconds !== 'number' ||
    !Number.isInteger(c.durationSeconds) ||
    c.durationSeconds < 300 ||
    c.durationSeconds > 10800
  ) {
    issues.push('durationSeconds must be an integer between 300 and 10800');
  }
  if (
    typeof c.headStartSeconds !== 'number' ||
    !Number.isInteger(c.headStartSeconds) ||
    c.headStartSeconds < 0 ||
    c.headStartSeconds > 1800
  ) {
    issues.push('headStartSeconds must be an integer between 0 and 1800');
  }
  if (
    typeof c.pingIntervalSeconds !== 'number' ||
    !Number.isInteger(c.pingIntervalSeconds) ||
    (c.pingIntervalSeconds !== 0 && (c.pingIntervalSeconds < 30 || c.pingIntervalSeconds > 1800))
  ) {
    issues.push('pingIntervalSeconds must be 0 (no pings) or an integer between 30 and 1800');
  }
  if (typeof c.zoneShrinkEnabled !== 'boolean') {
    issues.push('zoneShrinkEnabled must be a boolean');
  }
  if (
    typeof c.zoneShrinkIntervalSeconds !== 'number' ||
    !Number.isInteger(c.zoneShrinkIntervalSeconds) ||
    c.zoneShrinkIntervalSeconds < 60 ||
    c.zoneShrinkIntervalSeconds > 3600
  ) {
    issues.push('zoneShrinkIntervalSeconds must be an integer between 60 and 3600');
  }
  if (c.catchConfirmationRequired !== true) {
    issues.push('catchConfirmationRequired must be true — a tag never counts at once');
  }
  if (
    c.finalSizePercent !== undefined &&
    c.finalSizePercent !== null &&
    (typeof c.finalSizePercent !== 'number' ||
      c.finalSizePercent < 0 ||
      c.finalSizePercent > 100)
  ) {
    issues.push('finalSizePercent must be null (Auto) or a number between 0 and 100');
  }
  if (c.zoneShape !== undefined && c.zoneShape !== 'circle' && c.zoneShape !== 'draw') {
    issues.push("zoneShape must be 'circle' or 'draw'");
  }
  if (!Array.isArray(c.safeAreas)) {
    issues.push('safeAreas must be an array');
  }
  if (!Array.isArray(c.noGoAreas)) {
    issues.push('noGoAreas must be an array');
  } else {
    for (const area of c.noGoAreas) {
      if (!isValidGeoPolygon(area)) {
        issues.push('every no-go area must be a polygon of at least 3 valid points');
        break;
      }
    }
  }
  if (c.zone === undefined || typeof c.zone !== 'object' || c.zone === null) {
    issues.push('zone must be an object with a boundary');
  } else {
    for (const issue of validateZoneBoundary(c.zone.boundary)) {
      issues.push(`zone: ${issue}`);
    }
    if (Array.isArray(c.zone.shrinkPhases)) {
      for (const phase of c.zone.shrinkPhases) {
        if (typeof phase.atSeconds !== 'number' || phase.atSeconds < 0) {
          issues.push('every shrink phase needs a non-negative atSeconds');
          break;
        }
        for (const issue of validateZoneBoundary(phase.boundary)) {
          issues.push(`shrink phase: ${issue}`);
          break;
        }
      }
    } else {
      issues.push('zone.shrinkPhases must be an array');
    }
  }
  if (!Array.isArray(c.selectedHunterIds)) {
    issues.push('selectedHunterIds must be an array');
  } else {
    const seen = new Set<string>();
    for (const id of c.selectedHunterIds) {
      if (typeof id !== 'string' || id.length === 0) {
        issues.push('selectedHunterIds must contain non-empty string ids');
        break;
      }
      if (seen.has(id)) {
        issues.push('selectedHunterIds must not contain repeats');
        break;
      }
      seen.add(id);
    }
    // 'selected' needs a pick the roster COULD satisfy — but the exact
    // count is decided at start from the roster (balance table when
    // Balance is ON), which this roster-blind validator cannot know. So
    // it enforces only the knowable bounds (≥ 1 pick, ≤ maxPlayers − 1);
    // demanding exactly `hunterCount` here made Balance-ON configs
    // unstartable: the validator wanted the stored stepper value while
    // the draw wanted the table value. The exact count is enforced at
    // start (assignRoles, plain-words error) and by the lobby gate.
    if (c.teamAssignment === 'selected') {
      const maxPick = typeof c.maxPlayers === 'number' ? c.maxPlayers - 1 : 29;
      if (c.selectedHunterIds.length < 1 || c.selectedHunterIds.length > maxPick) {
        issues.push(
          'with teamAssignment selected, pick at least 1 Hunter and at most maxPlayers − 1',
        );
      }
    }
    if (c.teamAssignment === 'random' && c.selectedHunterIds.length !== 0) {
      issues.push('with teamAssignment random, no Hunters may be picked (Random clears the pick)');
    }
  }
  if (c.hostOnSiteConfirmed !== true) {
    issues.push('hostOnSiteConfirmed is required — the host confirms they are on site');
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Catch token format (≥ 128 bits)
// ---------------------------------------------------------------------------

/** Fresh catch token: 32 uppercase hex chars = 128 bits. The old 12-char (48-bit) token is rejected. */
export const CATCH_TOKEN_PATTERN = new RegExp(`^[0-9A-F]{${CATCH_TOKEN_HEX_LENGTH}}$`);

/** A raw catch token is valid only in the fresh ≥128-bit form. */
export function isValidCatchToken(token: unknown): token is string {
  return typeof token === 'string' && CATCH_TOKEN_PATTERN.test(token);
}

// ---------------------------------------------------------------------------
// Accuracy tiers + balance + suggested radius
// ---------------------------------------------------------------------------

/**
 * GPS accuracy tier. Thresholds are OPEN calibration (good ≤ 10 m, fair ≤ 25 m,
 * poor ≤ 60 m). The SERVER decides the tier; poor accuracy warns, never rejects.
 */
export function classifyAccuracy(accuracyMeters: number): LocationQuality {
  if (accuracyMeters <= ACCURACY_GOOD_M) return 'good';
  if (accuracyMeters <= ACCURACY_FAIR_M) return 'fair';
  return 'poor';
}

/**
 * Hunter balance table: 2–4 → 1, 5–8 → 2, 9–16 → 3, 17–24 → 4, 25–30 → 5.
 * OPEN calibration. Returns 1 for rosters below 2 (never called with < 2 at start).
 */
export function balancedHunterCount(playerCount: number): number {
  for (const row of BALANCED_HUNTER_TABLE) {
    if (playerCount >= row.minPlayers && playerCount <= row.maxPlayers) {
      return row.hunters;
    }
  }
  return 1;
}

/**
 * Suggested zone radius: 200 m + 25 m per player beyond 3, capped at 1000 m
 * as a starting point only. OPEN — never a requirement.
 */
export function suggestZoneRadiusMeters(playerCount: number): number {
  const extra = Math.max(0, playerCount - 3) * SUGGESTED_ZONE_RADIUS_PER_PLAYER_M;
  return Math.min(
    SUGGESTED_ZONE_RADIUS_CAP_M,
    Math.max(ZONE_RADIUS_MIN_M, SUGGESTED_ZONE_RADIUS_BASE_M + extra),
  );
}

// ---------------------------------------------------------------------------
// Hello credential scan
// ---------------------------------------------------------------------------

const HELLO_CREDENTIAL_KEYS = new Set([
  'token',
  'ticket',
  'password',
  'authtoken',
  'reconnecttoken',
  'hosttoken',
]);

/**
 * `hello` carries NO credential. Returns true if the payload contains a
 * credential key anywhere (any depth, any casing) — such a hello is rejected
 * with VALIDATION_FAILED and audited.
 */
export function helloHasCredential(payload: unknown): boolean {
  const seen = new Set<object>();
  const walk = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (walk(item)) return true;
      }
      return false;
    }
    for (const key of Object.keys(value)) {
      if (HELLO_CREDENTIAL_KEYS.has(key.toLowerCase())) return true;
      if (walk((value as Record<string, unknown>)[key])) return true;
    }
    return false;
  };
  return walk(payload);
}
