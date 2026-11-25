/**
 * House-rules presets (Scope C item 5) — one tap for common games.
 *
 * Quick / Standard / Big park set the timing fields (round length,
 * head start, pings) plus the zone size and the shrink switch; the
 * steppers stay the controls, so a host can still change any value
 * afterwards — doing so drops the preset to Custom. "Save" stores the
 * current settings as the Custom preset on this device, so the host
 * can pick them again next time.
 *
 * Pure logic only (no DOM, no storage writes except the explicit
 * save/load pair) so the unit suite can pin the matching exactly.
 * The zone size only applies when the zone is a circle: a drawn zone
 * has no single radius, so a preset never rewrites a drawn shape and
 * matching ignores the radius then.
 */
import { shrinkIntervalForDurationSeconds, type RoomConfig } from '@pakdam/shared';

export type HousePresetId = 'quick' | 'standard' | 'big-park' | 'custom';

export interface HousePreset {
  id: HousePresetId;
  label: string;
  /** One-line plain-words explainer, shown under the preset row. */
  line: string;
  durationSeconds: number;
  headStartSeconds: number;
  pingIntervalSeconds: number;
  /** Zone radius in metres (circle zones only). */
  zoneRadiusMeters: number;
  zoneShrinkEnabled: boolean;
}

export const HOUSE_PRESETS: HousePreset[] = [
  {
    id: 'quick',
    label: 'Quick',
    line: 'A short game — 10 minutes, small zone, pings every 30 seconds.',
    durationSeconds: 600,
    headStartSeconds: 60,
    pingIntervalSeconds: 30,
    zoneRadiusMeters: 200,
    zoneShrinkEnabled: true,
  },
  {
    id: 'standard',
    label: 'Standard',
    line: 'The usual game — 30 minutes, 500 m zone, pings every 3 minutes.',
    durationSeconds: 1800,
    headStartSeconds: 180,
    pingIntervalSeconds: 180,
    zoneRadiusMeters: 500,
    zoneShrinkEnabled: true,
  },
  {
    id: 'big-park',
    label: 'Big park',
    line: 'A long game over a big area — 60 minutes, 800 m zone, pings every 5 minutes.',
    durationSeconds: 3600,
    headStartSeconds: 300,
    pingIntervalSeconds: 300,
    zoneRadiusMeters: 800,
    zoneShrinkEnabled: true,
  },
];

const CUSTOM_PRESET_KEY = 'pakdam.house-rules.custom.v1';

/** The Custom preset's saved values, or null when nothing was saved yet. */
export function loadCustomPreset(): HousePreset | null {
  try {
    const raw = window.localStorage.getItem(CUSTOM_PRESET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HousePreset>;
    if (
      typeof parsed.durationSeconds !== 'number' ||
      typeof parsed.headStartSeconds !== 'number' ||
      typeof parsed.pingIntervalSeconds !== 'number' ||
      typeof parsed.zoneRadiusMeters !== 'number' ||
      typeof parsed.zoneShrinkEnabled !== 'boolean'
    ) {
      return null;
    }
    return {
      id: 'custom',
      label: 'Custom',
      line: 'Your saved settings.',
      durationSeconds: parsed.durationSeconds,
      headStartSeconds: parsed.headStartSeconds,
      pingIntervalSeconds: parsed.pingIntervalSeconds,
      zoneRadiusMeters: parsed.zoneRadiusMeters,
      zoneShrinkEnabled: parsed.zoneShrinkEnabled,
    };
  } catch {
    return null;
  }
}

/** Save the current settings as the Custom preset on this device. */
export function saveCustomPreset(preset: Omit<HousePreset, 'id' | 'label' | 'line'>): void {
  try {
    window.localStorage.setItem(
      CUSTOM_PRESET_KEY,
      JSON.stringify({ ...preset, id: 'custom' }),
    );
  } catch {
    // Storage is best-effort — the Save button still reports it saved
    // the in-memory values for this session via the caller's state.
  }
}

/**
 * Which built-in preset the current settings match, or null when they
 * match none (changed settings, or a saved Custom — see
 * `matchHousePreset`, which checks the saved Custom after these).
 */
export function matchBuiltInPreset(
  config: Pick<
    RoomConfig,
    'durationSeconds' | 'headStartSeconds' | 'pingIntervalSeconds' | 'zoneShrinkEnabled'
  >,
  zoneRadiusMeters: number | null,
): 'quick' | 'standard' | 'big-park' | null {
  for (const preset of HOUSE_PRESETS) {
    if (
      config.durationSeconds === preset.durationSeconds &&
      config.headStartSeconds === preset.headStartSeconds &&
      config.pingIntervalSeconds === preset.pingIntervalSeconds &&
      config.zoneShrinkEnabled === preset.zoneShrinkEnabled &&
      (zoneRadiusMeters === null || zoneRadiusMeters === preset.zoneRadiusMeters)
    ) {
      return preset.id as 'quick' | 'standard' | 'big-park';
    }
  }
  return null;
}

/**
 * Which preset the current settings match, or 'custom' when they match
 * none (including a saved Custom preset — that is matched by value
 * too, so a saved Custom that still matches reads as Custom, not as
 * one of the three built-ins). `zoneRadiusMeters` is null for a drawn
 * zone, where the radius is ignored.
 */
/** True when the current settings equal the saved Custom preset. */
export function matchesCustomPreset(
  config: Pick<
    RoomConfig,
    'durationSeconds' | 'headStartSeconds' | 'pingIntervalSeconds' | 'zoneShrinkEnabled'
  >,
  zoneRadiusMeters: number | null,
  custom: HousePreset | null,
): boolean {
  if (!custom) return false;
  return (
    config.durationSeconds === custom.durationSeconds &&
    config.headStartSeconds === custom.headStartSeconds &&
    config.pingIntervalSeconds === custom.pingIntervalSeconds &&
    config.zoneShrinkEnabled === custom.zoneShrinkEnabled &&
    (zoneRadiusMeters === null || zoneRadiusMeters === custom.zoneRadiusMeters)
  );
}

export function matchHousePreset(
  config: Pick<
    RoomConfig,
    'durationSeconds' | 'headStartSeconds' | 'pingIntervalSeconds' | 'zoneShrinkEnabled'
  >,
  zoneRadiusMeters: number | null,
  custom: HousePreset | null = null,
): HousePresetId {
  const builtIn = matchBuiltInPreset(config, zoneRadiusMeters);
  if (builtIn) return builtIn;
  if (matchesCustomPreset(config, zoneRadiusMeters, custom)) return 'custom';
  return 'custom';
}

/**
 * The config patch a preset applies. The shrink interval follows the
 * round length (3 shrinks per game), exactly like the Round length
 * stepper does — a preset must never leave a stale shrink interval
 * behind.
 */
export function applyHousePreset(
  config: RoomConfig,
  preset: HousePreset,
): RoomConfig {
  return {
    ...config,
    durationSeconds: preset.durationSeconds,
    headStartSeconds: preset.headStartSeconds,
    pingIntervalSeconds: preset.pingIntervalSeconds,
    zoneShrinkEnabled: preset.zoneShrinkEnabled,
    zoneShrinkIntervalSeconds: shrinkIntervalForDurationSeconds(preset.durationSeconds),
  };
}
