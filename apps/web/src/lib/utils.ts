/**
 * Formatting helpers — plain-words labels the UI shows.
 * Ages use `m:ss` (e.g. `0:20`); numbers that count use tabular figures.
 */
import { formatAgeLabel, haversineMeters, type GeoPoint } from '@pakdam/shared';

export { formatAgeLabel, haversineMeters };
export type { GeoPoint };

/** `0:20 ago` — the age of a ping / fix, from a timestamp. */
export function ageLabelFromTimestamp(timestampMs: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  return `${formatAgeLabel(seconds)} ago`;
}

/** Countdown `mm:ss` for a remaining duration in seconds (never negative). */
export function formatCountdown(totalSeconds: number): string {
  return formatAgeLabel(Math.max(0, Math.floor(totalSeconds)));
}

/** `27:07` — a match clock from milliseconds remaining. */
export function formatClock(msRemaining: number): string {
  return formatAgeLabel(Math.max(0, Math.floor(msRemaining / 1000)));
}

/** Distance in metres between two points (great-circle). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  return haversineMeters(a, b);
}

/** `420 m` / `1.2 km` — human distance. */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** `500 m` zone size as `500 m → 211 m` (start → final; ~42% when Auto). */
export function formatZoneSize(startRadiusM: number, finalRadiusM: number | null): string {
  const finalLabel = finalRadiusM === null ? 'Auto' : formatDistance(finalRadiusM);
  return `${formatDistance(startRadiusM)} → ${finalLabel}`;
}

/** `3 min` / `45 s` — a duration in seconds, shortest sensible unit. */
export function formatDurationShort(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/** Uppercase initials for an avatar square (first letters of the first two words). */
export function initialsForName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}
