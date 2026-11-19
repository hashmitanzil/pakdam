/**
 * Room summary strip (SCRAM-SPEC §7.1).
 *
 * One tappable line, zone · hunters · ping interval · match length, in that
 * order: `500m zone · 2 hunters · 3m pulse · 30m`. The host tap scrolls to
 * the Rules section; a guest tap answers `Only the host can change the
 * game settings.` (the page owns the tap behaviour — this module only
 * formats the line).
 */
import { balancedHunterCount, type RoomConfig } from '@pakdam/shared';
import { boundaryRadiusMeters } from './drawPoints';

function shortMinutes(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0m';
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = totalSeconds / 60;
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

function hunterCountFor(config: RoomConfig, activePlayerCount: number): number {
  if (config.balanceHunters === false) return config.hunterCount;
  return balancedHunterCount(Math.max(3, activePlayerCount));
}

/**
 * `500m zone · 2 hunters · 3m pulse · 30m`
 * (pings off reads `no pings` instead of a pulse interval).
 */
export function formatRoomSummary(
  config: RoomConfig,
  activePlayerCount: number,
): string {
  const radius = boundaryRadiusMeters(config.zone.boundary);
  const hunters = hunterCountFor(config, activePlayerCount);
  const ping =
    config.playZoneEnabled === false || config.pingIntervalSeconds === 0
      ? 'no pings'
      : `${shortMinutes(config.pingIntervalSeconds)} pulse`;
  return `${radius}m zone · ${hunters} ${hunters === 1 ? 'hunter' : 'hunters'} · ${ping} · ${shortMinutes(config.durationSeconds)}`;
}
