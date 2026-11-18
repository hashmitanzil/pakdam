'use client';
import {
  CALIBRATION_OPEN, DEFAULT_HOST_TOGGLES, ZONE_RADIUS_DEFAULT_M, ZONE_RADIUS_UI_MAX_M,
  ZONE_RADIUS_MIN_M, ZONE_RADIUS_STEP_M, suggestZoneRadiusMeters, validateRules,
} from '@pakdam/shared';
import type { GeoPolygon, HouseRulePreset, HouseRules, RoomConfig } from '@pakdam/shared';
import { balancedHunterCount, shrinkTimesSeconds, zoneDiameterMeters } from '@pakdam/engine';
import { circlePolygon, scalePolygonTowardCentroid } from '@/components/match/ZoneEditor';
import { formatDistance, polygonCentroid } from '@/components/match/freshness';

/**
 * Host-setup draft — the single state object behind the create screen
 * AND the lobby settings sheet, so the two can never drift apart.
 * HouseRules (mode, timing, toggles) + the zone the host drew on the
 * map (centre, radius, no-go areas). There is NO area/place-name field
 * anywhere in this flow: the game starts from LOCATION.
 *
 * Stepper steps (location-first redesign, Nov 2026 — the ranges the
 * founder's reference frames use, in Pakdam's own wording):
 * - Match length: 5 / 10 / 15 / 30 / 45 min, up to 3 h
 * - Head start: none / 30 s / 1 m 30 s / 3 / 5 / 10 / 15 / 30 min
 * - Location ping: none / 30 s / 1 / 3 / 5 / 7 / 10 / 15 / 30 min
 * - Shrinks every: 1 / 3 / 10 / 20 / 30 / 60 min
 * - Zone radius: 100 m minimum, NO maximum (founder decision,
 *   2026-11-17 — unlimited past 1 km), step 50 m, default 500 m.
 *   The slider / stepper list tops out at ZONE_RADIUS_UI_MAX_M
 *   (10 km) as a convenience range only — the + controls keep
 *   growing past it and validation never caps the size.
 * - Hunters (Balance OFF): 1 up to players − 1
 * All numeric values inside these ranges are calibration OPEN.
 */
export interface HostSetupDraft extends HouseRules {
  centreLat: number | null;
  centreLng: number | null;
  radiusMeters: number;
  noGoAreas: GeoPolygon[];
  /** 'circle' = radius stepper around the centre. 'draw' = a custom
   *  polygon on the map (draggable corners). Circle stays the default. */
  zoneShape: 'circle' | 'draw';
  /** The drawn polygon (Draw mode only). Null until the host draws one. */
  drawnBoundary: GeoPolygon | null;
  /** Final zone size as % of the starting size, or null = Auto. */
  finalSizePercent: number | null;
}

export const DRAW_DEFAULT_CORNERS = 6;
export const CORNER_STEPS = [3, 4, 5, 6, 8, 10, 12] as const;
export const FINAL_SIZE_STEPS = [10, 15, 20, 25, 30, 40, 50, 60, 75, 100] as const;

export const DURATION_STEPS_MIN = [5, 10, 15, 30, 45, 60, 90, 120, 180] as const;
export const HEAD_START_STEPS_S = [0, 30, 90, 180, 300, 600, 900, 1800] as const;
export const PING_STEPS_S = [0, 30, 60, 180, 300, 420, 600, 900, 1800] as const;
export const SHRINK_STEPS_MIN = [1, 3, 10, 20, 30, 60] as const;
/** Slider / stepper convenience range: `max` is the UI range top
 *  (ZONE_RADIUS_UI_MAX_M, 10 km), NOT a rule — validation accepts
 *  any radius >= min, and the steps list grows past `max` when the
 *  current radius is already larger (see HostSetupForm). */
export const RADIUS_BOUNDS = { min: ZONE_RADIUS_MIN_M, max: ZONE_RADIUS_UI_MAX_M, step: ZONE_RADIUS_STEP_M, def: ZONE_RADIUS_DEFAULT_M } as const;

/** The create screen's starting point: Manhunt/Classic, 6 players,
 *  Balance ON, Random draw ON, 30 min, 3 min head start, ping every
 *  3 min, shrink on every 10 min, 500 m zone, code-only. */
export function defaultDraft(): HostSetupDraft {
  return {
    mode: 'classic', teamAssignment: 'random', maxPlayers: 6, hunterCount: 2,
    durationSeconds: 1800, headStartSeconds: 180, pingIntervalSeconds: 180,
    zoneShrinkEnabled: true, zoneShrinkIntervalSeconds: 600,
    catchConfirmationRequired: true,
    ...DEFAULT_HOST_TOGGLES,
    playZoneEnabled: true, huntersCanTalk: true, finalSizePercent: null,
    centreLat: null, centreLng: null, radiusMeters: ZONE_RADIUS_DEFAULT_M, noGoAreas: [],
    zoneShape: 'circle', drawnBoundary: null,
  };
}

/** Effective final zone size (% of the starting size). An explicit
 *  host value wins; Auto means the existing shrink rule — the zone
 *  keeps 75% of its size per shrink — so the final size follows from
 *  the shrink schedule, and is 100% when shrinking is off. */
export function effectiveFinalSizePercent(d: Pick<HostSetupDraft, 'zoneShrinkEnabled' | 'zoneShrinkIntervalSeconds' | 'durationSeconds' | 'finalSizePercent'>): number {
  if (d.finalSizePercent !== null && d.finalSizePercent !== undefined) return d.finalSizePercent;
  if (!d.zoneShrinkEnabled) return 100;
  const n = shrinkTimesSeconds(d.durationSeconds, d.zoneShrinkIntervalSeconds, true).length;
  return Math.max(5, Math.round(100 * 0.75 ** n));
}

/** Per-shrink scale factors, interpolating geometrically from 100% to
 *  the effective final size across the scheduled shrinks. With Auto
 *  final size this reproduces the existing rule exactly (0.75 per
 *  shrink); an explicit final size bends the same schedule to land on
 *  it at the last shrink. Empty when shrinking is off. */
export function shrinkScaleFactors(d: Pick<HostSetupDraft, 'zoneShrinkEnabled' | 'zoneShrinkIntervalSeconds' | 'durationSeconds' | 'finalSizePercent'>): number[] {
  const times = shrinkTimesSeconds(d.durationSeconds, d.zoneShrinkIntervalSeconds, d.zoneShrinkEnabled);
  if (times.length === 0) return [];
  const final = effectiveFinalSizePercent(d) / 100;
  return times.map((_, i) => final ** ((i + 1) / times.length));
}

/** The starting drawn polygon for Draw mode: a regular N-gon around
 *  the current centre at the current radius. Null when no centre is
 *  set yet — the host must place the centre first. */
export function drawnBoundaryFor(d: Pick<HostSetupDraft, 'centreLat' | 'centreLng' | 'radiusMeters'>, corners: number): GeoPolygon | null {
  if (d.centreLat == null || d.centreLng == null) return null;
  return circlePolygon(d.centreLat, d.centreLng, d.radiusMeters, Math.max(3, corners));
}

/** Resize a drawn polygon so its widest distance across equals the
 *  target diameter (scale toward its centroid). */
export function scaleDrawnToDiameter(poly: GeoPolygon, targetDiameterMeters: number): GeoPolygon {
  const current = zoneDiameterMeters(poly);
  if (current <= 0 || targetDiameterMeters <= 0) return poly;
  return scalePolygonTowardCentroid(poly, targetDiameterMeters / current);
}

/** Effective Hunter count for a draft: Balance ON reads the
 *  provisional table from the roster size at match start; otherwise
 *  the host's stepper value. */
export function effectiveHunterCount(d: Pick<HostSetupDraft, 'balanceHunters' | 'maxPlayers' | 'hunterCount' | 'mode'>): number {
  const n = d.balanceHunters ? balancedHunterCount(d.maxPlayers) : d.hunterCount;
  return Math.max(1, Math.min(n, d.maxPlayers - 1));
}

/** Mode rules, applied wherever a draft is rebuilt from stored
 *  rules (config, preset, or a fresh config). Classic and Infection
 *  carry no forced rules, so the rules pass through unchanged. */
export function applyModeRules(r: HouseRules): HouseRules {
  return r;
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
/** Short seconds: 30 -> "30s", 90 -> "1m 30s", 180 -> "3 min", 0 -> "None". */
export function formatSecondsShort(s: number): string {
  if (s === 0) return 'None';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} min` : `${m}m ${rest}s`;
}
export function formatPing(s: number): string {
  return s === 0 ? 'No pings' : `every ${formatSecondsShort(s)}`;
}

/** Room summary strip, computed from the real settings — the line the
 *  lobby shows under the room code ("500m zone · 1 hunter · 30s pulse
 *  · 15m" style). */
export function roomSummaryStrip(d: HostSetupDraft): string {
  const hunters = effectiveHunterCount(d);
  const ping = d.pingIntervalSeconds === 0 ? 'no pings' : `${formatSecondsShort(d.pingIntervalSeconds)} pulse`;
  const zone = !d.playZoneEnabled
    ? 'no zone'
    : d.zoneShape === 'draw' && d.drawnBoundary
      ? `${formatDistance(zoneDiameterMeters(d.drawnBoundary))} custom zone`
      : `${formatDistance(d.radiusMeters * 2)} zone`;
  return `${zone} · ${hunters} hunter${hunters === 1 ? '' : 's'} · ${ping} · ${formatMinutes(d.durationSeconds / 60)}`;
}

/** Suggested radius for the current player count, labelled as a
 *  suggestion wherever it is shown (formula lives in shared). */
export function suggestedRadiusFor(d: Pick<HostSetupDraft, 'maxPlayers'>): number {
  return suggestZoneRadiusMeters(d.maxPlayers);
}

/** Validate a draft before creating a room or saving it from the
 *  settings sheet. Returns plain-language errors (empty = valid). */
export function validateDraft(d: HostSetupDraft): string[] {
  const e = validateRules(d);
  // Play zone OFF = classic hide and seek: no centre, no size, no
  // pings and no shrink to check — the zone is simply not there.
  if (!d.playZoneEnabled) return e;
  if (d.zoneShape === 'draw') {
    if (!d.drawnBoundary || d.drawnBoundary.length < 3) {
      e.push('Draw the zone first — switch to Draw and place at least 3 corners on the map.');
    } else {
      const dia = zoneDiameterMeters(d.drawnBoundary);
      if (dia < 200) e.push('Drawn zone must be at least 200 m across (no maximum).');
    }
    return e;
  }
  if (d.centreLat == null || d.centreLng == null) e.push('Set the zone centre first — tap “Use my location” or tap the map.');
  if (d.radiusMeters < ZONE_RADIUS_MIN_M) {
    e.push(`Zone radius must be at least ${ZONE_RADIUS_MIN_M} m (no maximum).`);
  }
  return e;
}

/** Build the RoomConfig a draft creates.
 *  Circle: a 32-point circle boundary around the centre, plus one
 *  smaller zone per shrink (scale factors interpolate to the final
 *  size — Auto reproduces the old 75%-per-shrink rule exactly).
 *  Draw: the host's polygon as the boundary, plus one scaled copy per
 *  shrink (scaled toward the polygon centroid by the same factors).
 *  The stored shrink-phase boundaries are SIZE PLACEHOLDERS ONLY:
 *  concentric scaled copies that carry the right size (diameter) for
 *  each phase and NO position. The real next zone is PUBG/BGMI-style
 *  (founder decision, 2026-11-17): smaller AND randomly offset fully
 *  inside the zone before it — not concentric — and the random draw
 *  happens on the SERVER, per shrink, at the moment the shrink fires
 *  (workers/src/room-do.ts alarmTick). The server reads only the
 *  stored phase's SIZE (its diameter relative to the previous
 *  boundary) and re-draws the position itself, so no client can fix
 *  the next zone in advance — and the next-zone preview the players
 *  see is a preview of the planned size, never the final zone.
 *  Play zone OFF: no boundary, no shrink phases — classic hide and
 *  seek. No-go areas are drawn shapes, never names. */
export function draftToConfig(d: HostSetupDraft, opts: { hostOnSiteConfirmed: boolean; selectedHunterIds?: string[] }): RoomConfig {
  const times = shrinkTimesSeconds(d.durationSeconds, d.zoneShrinkIntervalSeconds, d.zoneShrinkEnabled);
  const factors = shrinkScaleFactors(d);
  let boundary: GeoPolygon = [];
  let shrinkPhases: { atSeconds: number; boundary: GeoPolygon }[] = [];
  if (d.playZoneEnabled) {
    if (d.zoneShape === 'draw' && d.drawnBoundary && d.drawnBoundary.length >= 3) {
      boundary = d.drawnBoundary;
    } else if (d.centreLat != null && d.centreLng != null) {
      boundary = circlePolygon(d.centreLat, d.centreLng, d.radiusMeters, 32);
    }
    // No centre yet means no boundary: the zone stays un-centred
    // rather than falling back to any default place. Both callers
    // (create page, settings sheet) validate the draft first, so a
    // centre-less circle zone is unreachable from the UI.
    // Chain the shrinks as SIZE PLACEHOLDERS ONLY: each next phase
    // is a concentric scaled copy of the boundary before it, so the
    // size at each phase still follows the host's shrink setting
    // exactly — the POSITION is deliberately not drawn here. The
    // server draws the real (randomly offset) boundary per shrink
    // and reads only this placeholder's diameter to get the size.
    let prev = boundary;
    shrinkPhases = times.map((atSeconds, i) => {
      const rel = (factors[i] ?? 1) / (i === 0 ? 1 : (factors[i - 1] ?? 1));
      const next = scalePolygonTowardCentroid(prev, rel);
      prev = next;
      return { atSeconds, boundary: next };
    });
  }
  const rules: HouseRules = applyModeRules({
    mode: d.mode, teamAssignment: d.teamAssignment, maxPlayers: d.maxPlayers,
    hunterCount: d.hunterCount, durationSeconds: d.durationSeconds,
    headStartSeconds: d.headStartSeconds, pingIntervalSeconds: d.pingIntervalSeconds,
    zoneShrinkEnabled: d.zoneShrinkEnabled, zoneShrinkIntervalSeconds: d.zoneShrinkIntervalSeconds,
    catchConfirmationRequired: d.catchConfirmationRequired,
    balanceHunters: d.balanceHunters, randomDraw: d.randomDraw,
    showPingHistory: d.showPingHistory,
    playZoneEnabled: d.playZoneEnabled, huntersCanTalk: d.huntersCanTalk,
    finalSizePercent: d.finalSizePercent,
  });
  return {
    ...rules,
    zone: { boundary, shrinkPhases },
    zoneShape: d.zoneShape,
    safeAreas: [],
    noGoAreas: d.noGoAreas,
    selectedHunterIds: opts.selectedHunterIds ?? [],
    hostOnSiteConfirmed: opts.hostOnSiteConfirmed,
  };
}

/** Rebuild a draft from a stored room config (settings sheet): the
 *  centre is the boundary centroid, the radius half the diameter.
 *  Draw rooms come back as Draw, with their polygon intact. */
export function draftFromConfig(c: RoomConfig): HostSetupDraft {
  const centre = polygonCentroid(c.zone.boundary);
  const shape = c.zoneShape ?? 'circle';
  let radius = ZONE_RADIUS_DEFAULT_M;
  if (centre) {
    let max = 0;
    for (const p of c.zone.boundary) {
      const dLat = (p.lat - centre.lat) * 111320;
      const dLng = (p.lng - centre.lng) * 111320 * Math.cos((centre.lat * Math.PI) / 180);
      max = Math.max(max, Math.sqrt(dLat * dLat + dLng * dLng));
    }
    if (max > 0) radius = Math.round(Math.max(ZONE_RADIUS_MIN_M, max));
  }
  const rules: HouseRules = applyModeRules({
    mode: c.mode, teamAssignment: c.teamAssignment, maxPlayers: c.maxPlayers,
    hunterCount: c.hunterCount, durationSeconds: c.durationSeconds,
    headStartSeconds: c.headStartSeconds, pingIntervalSeconds: c.pingIntervalSeconds,
    zoneShrinkEnabled: c.zoneShrinkEnabled, zoneShrinkIntervalSeconds: c.zoneShrinkIntervalSeconds,
    catchConfirmationRequired: c.catchConfirmationRequired,
    balanceHunters: c.balanceHunters, randomDraw: c.randomDraw,
    showPingHistory: c.showPingHistory,
    playZoneEnabled: c.playZoneEnabled ?? true, huntersCanTalk: c.huntersCanTalk ?? true,
    finalSizePercent: c.finalSizePercent ?? null,
  });
  return {
    ...rules,
    centreLat: centre?.lat ?? null,
    centreLng: centre?.lng ?? null,
    radiusMeters: radius,
    noGoAreas: [...c.noGoAreas],
    zoneShape: shape,
    drawnBoundary: shape === 'draw' && c.zone.boundary.length >= 3 ? [...c.zone.boundary] : null,
    finalSizePercent: c.finalSizePercent ?? null,
  };
}

// --- Built-in presets (Quick / Standard / Big Park) ---
export type BuiltInPresetId = 'quick' | 'standard' | 'big-park';
export const BUILT_INS: Record<BuiltInPresetId, { label: string; blurb: string; rules: Omit<HouseRules, 'maxPlayers'>; radiusMeters: number }> = {
  quick: {
    label: 'Quick', blurb: 'The Phase 0 default — a short, sharp game', radiusMeters: 500,
    rules: { mode: 'classic', teamAssignment: 'random', hunterCount: 1, durationSeconds: CALIBRATION_OPEN.quickPresetDurationSeconds, headStartSeconds: CALIBRATION_OPEN.headStartSeconds, pingIntervalSeconds: CALIBRATION_OPEN.pingIntervalSeconds, zoneShrinkEnabled: true, zoneShrinkIntervalSeconds: CALIBRATION_OPEN.zoneShrinkIntervalSeconds, catchConfirmationRequired: true, ...DEFAULT_HOST_TOGGLES },
  },
  standard: {
    label: 'Standard', blurb: 'A full game with room to hide', radiusMeters: 500,
    rules: { mode: 'classic', teamAssignment: 'random', hunterCount: 2, durationSeconds: CALIBRATION_OPEN.standardDurationSeconds, headStartSeconds: CALIBRATION_OPEN.headStartSeconds, pingIntervalSeconds: CALIBRATION_OPEN.pingIntervalSeconds, zoneShrinkEnabled: true, zoneShrinkIntervalSeconds: CALIBRATION_OPEN.zoneShrinkIntervalSeconds, catchConfirmationRequired: true, ...DEFAULT_HOST_TOGGLES },
  },
  'big-park': {
    label: 'Big Park', blurb: 'A bigger ground, more Hunters', radiusMeters: 1000,
    rules: { mode: 'classic', teamAssignment: 'random', hunterCount: 3, durationSeconds: CALIBRATION_OPEN.standardDurationSeconds, headStartSeconds: CALIBRATION_OPEN.headStartSeconds, pingIntervalSeconds: CALIBRATION_OPEN.pingIntervalSeconds, zoneShrinkEnabled: true, zoneShrinkIntervalSeconds: CALIBRATION_OPEN.zoneShrinkIntervalSeconds, catchConfirmationRequired: true, ...DEFAULT_HOST_TOGGLES },
  },
};

// --- House-rule presets on this device (localStorage) ---
export const HOUSE_PRESETS_KEY = 'pakdam.house-presets.v1';
export function loadHousePresets(): HouseRulePreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HOUSE_PRESETS_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as HouseRulePreset[]) : [];
  } catch {
    return [];
  }
}
export function saveHousePresets(next: HouseRulePreset[]): void {
  try { localStorage.setItem(HOUSE_PRESETS_KEY, JSON.stringify(next)); } catch { /* storage full — kept for this session only */ }
}
/** Apply a saved preset's rules (and zone size, when the preset has
 *  one) onto a draft. Rules saved before the new toggles existed get
 *  the create screen's defaults, not the legacy ones — a preset is an
 *  explicit host choice, so Balance/Random stay ON as the host saved
 *  them in the new flow. */
export function applyPresetToDraft(d: HostSetupDraft, p: HouseRulePreset): HostSetupDraft {
  const r = p.rules;
  return {
    ...d,
    ...applyModeRules(r),
    balanceHunters: r.balanceHunters ?? DEFAULT_HOST_TOGGLES.balanceHunters,
    randomDraw: r.randomDraw ?? DEFAULT_HOST_TOGGLES.randomDraw,
    showPingHistory: r.showPingHistory ?? DEFAULT_HOST_TOGGLES.showPingHistory,
    playZoneEnabled: r.playZoneEnabled ?? d.playZoneEnabled,
    huntersCanTalk: r.huntersCanTalk ?? d.huntersCanTalk,
    finalSizePercent: r.finalSizePercent ?? d.finalSizePercent,
    hunterCount: Math.min(r.hunterCount, r.maxPlayers - 1),
    radiusMeters: p.radiusMeters ?? d.radiusMeters,
  };
}
