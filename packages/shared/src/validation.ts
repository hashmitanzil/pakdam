import type { HouseRulePreset, HouseRules, LocationFix, MatchMode, RoomConfig, TeamAssignment } from './types.js';
export function isValidDisplayName(n: string): boolean {
  return typeof n === 'string' && n.trim().length >= 1 && n.trim().length <= 30 && !/https?:\/\//i.test(n);
}
export function isValidRoomCode(c: string): boolean { return /^[A-Z0-9]{6}$/.test(c); }
export function isValidFix(f: LocationFix): boolean {
  return f.lat >= -90 && f.lat <= 90 && f.lng >= -180 && f.lng <= 180 &&
    f.accuracyMeters > 0 && Number.isFinite(f.accuracyMeters);
}

export const MATCH_MODES: MatchMode[] = ['classic', 'infection'];
export const TEAM_ASSIGNMENTS: TeamAssignment[] = ['random', 'selected'];
/** Host ranges (Brief v2 + founder update + location-first redesign).
 *  All bounds are the brief's published ranges; the values inside them
 *  are calibration OPEN. Ping may be as frequent as every 30 s; shrink
 *  as frequent as every 1 min; zone diameter has a 200 m minimum and
 *  NO maximum (founder decision, 2026-11-17 — unlimited past 1 km;
 *  the old 3 km diameter cap is deleted with the 1.5 km radius cap). */
export const HOST_RANGES = {
  maxPlayers: { min: 3, max: 30 }, // founder 2026-11-17: personal game, limit raised 16 -> 30
  durationSeconds: { min: 300, max: 10800 }, // 5 min–3 h
  headStartSeconds: { min: 0, max: 1800 }, // 0–30 min
  pingIntervalSeconds: { min: 30, max: 1800 }, // 30 s–30 min, or 0 = no pings
  zoneShrinkIntervalSeconds: { min: 60, max: 3600 }, // every 1–60 min
  // No outside-zone ranges: the 30-second return countdown, then
  // ejection, is a fixed founder rule (OUTSIDE_ZONE_RETURN_SECONDS).
  // Zone across (diameter): minimum 200 m, NO maximum (founder
  // decision, 2026-11-17 — unlimited past 1 km).
  zoneDiameterMeters: { min: 200 },
} as const;

/** Great-circle distance, metres (local copy so shared stays free of
 *  the engine dependency). Used only to bound the zone diameter —
 *  and by gps-validation for movement/proximity checks. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Widest distance across a zone boundary, metres. */
export function zoneDiameterMeters(boundary: { lat: number; lng: number }[]): number {
  let max = 0;
  for (let i = 0; i < boundary.length; i++) {
    for (let j = i + 1; j < boundary.length; j++) {
      max = Math.max(max, haversineMeters(boundary[i]!.lat, boundary[i]!.lng, boundary[j]!.lat, boundary[j]!.lng));
    }
  }
  return Math.round(max);
}

/** Range + mode-rule checks shared by validateRoomConfig and
 *  validateHousePreset, so a saved preset can never hold rules a room
 *  would reject. No venue/area name is checked — the field does not exist. */
export function validateRules(r: HouseRules): string[] {
  const e: string[] = [];
  if (!MATCH_MODES.includes(r.mode)) e.push(`mode must be one of ${MATCH_MODES.join(', ')}`);
  if (!TEAM_ASSIGNMENTS.includes(r.teamAssignment)) e.push(`teamAssignment must be one of ${TEAM_ASSIGNMENTS.join(', ')}`);
  if (r.maxPlayers < HOST_RANGES.maxPlayers.min || r.maxPlayers > HOST_RANGES.maxPlayers.max) e.push('maxPlayers must be 3–30');
  if (r.hunterCount < 1 || r.hunterCount >= r.maxPlayers) e.push('hunterCount must be >=1 and < maxPlayers');
  if (r.durationSeconds < HOST_RANGES.durationSeconds.min || r.durationSeconds > HOST_RANGES.durationSeconds.max) e.push('durationSeconds must be 5 min–3 h (300–10800)');
  if (r.headStartSeconds < HOST_RANGES.headStartSeconds.min || r.headStartSeconds > HOST_RANGES.headStartSeconds.max) e.push('headStartSeconds must be 0–30 min (0–1800)');
  if (r.pingIntervalSeconds !== 0 && (r.pingIntervalSeconds < HOST_RANGES.pingIntervalSeconds.min || r.pingIntervalSeconds > HOST_RANGES.pingIntervalSeconds.max)) e.push('pingIntervalSeconds must be 0 (no pings) or 30 s–30 min (30–1800)');
  if (r.zoneShrinkEnabled && (r.zoneShrinkIntervalSeconds < HOST_RANGES.zoneShrinkIntervalSeconds.min || r.zoneShrinkIntervalSeconds > HOST_RANGES.zoneShrinkIntervalSeconds.max)) e.push('zoneShrinkIntervalSeconds must be 1–60 min (60–3600) when shrinking is on');
  for (const f of ['balanceHunters', 'randomDraw', 'showPingHistory'] as const) {
    if (r[f] !== undefined && typeof r[f] !== 'boolean') e.push(`${f} must be true or false when set`);
  }
  for (const f of ['playZoneEnabled', 'huntersCanTalk'] as const) {
    if (r[f] !== undefined && typeof r[f] !== 'boolean') e.push(`${f} must be true or false when set`);
  }
  if (r.finalSizePercent !== undefined && r.finalSizePercent !== null &&
    (typeof r.finalSizePercent !== 'number' || r.finalSizePercent < 5 || r.finalSizePercent > 100)) {
    e.push('finalSizePercent must be 5–100, or null for Auto');
  }
  if (r.playZoneEnabled === false && r.pingIntervalSeconds !== 0) {
    e.push('pingIntervalSeconds must be 0 (no pings) when the play zone is off');
  }
  return e;
}
export function validateRoomConfig(c: RoomConfig): string[] {
  const e = validateRules(c);
  if (!c.hostOnSiteConfirmed) e.push('host must confirm they will be on site');
  if (c.zoneShape !== undefined && c.zoneShape !== 'circle' && c.zoneShape !== 'draw') e.push('zoneShape must be circle or draw when set');
  // Play zone OFF = no boundary at all (classic hide and seek): the
  // boundary and diameter checks below do not apply.
  if (c.playZoneEnabled === false) {
    if (c.zone?.boundary && c.zone.boundary.length > 0) e.push('zone boundary must be empty when the play zone is off');
  } else if (!c.zone?.boundary || c.zone.boundary.length < 3) e.push('zone boundary needs >=3 points');
  else {
    const d = zoneDiameterMeters(c.zone.boundary);
    if (d < HOST_RANGES.zoneDiameterMeters.min) {
      e.push(`zone diameter must be at least ${HOST_RANGES.zoneDiameterMeters.min} m across (no maximum)`);
    }
  }
  if (c.selectedHunterIds.length > c.hunterCount) e.push('selectedHunterIds must hold at most hunterCount players');
  if (new Set(c.selectedHunterIds).size !== c.selectedHunterIds.length) e.push('selectedHunterIds must not repeat a player');
  return e;
}
export function validateHousePreset(p: HouseRulePreset): string[] {
  const e: string[] = [];
  if (!p.name.trim()) e.push('preset name is required');
  if (p.name.trim().length > 40) e.push('preset name must be 40 characters or fewer');
  e.push(...validateRules(p.rules));
  return e;
}
export function classifyAccuracy(accuracyM: number, cal: { accuracyGoodMaxM: number; accuracyFairMaxM: number; accuracyPoorMaxM: number }): 'good' | 'fair' | 'poor' {
  if (accuracyM <= cal.accuracyGoodMaxM) return 'good';
  if (accuracyM <= cal.accuracyFairMaxM) return 'fair';
  if (accuracyM <= cal.accuracyPoorMaxM) return 'poor';
  return 'poor'; // poor accuracy is NEVER cheating evidence — it is only a quality tier (HNT-034)
}
