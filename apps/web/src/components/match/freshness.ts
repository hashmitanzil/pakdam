/**
 * Freshness helpers for the play HUD.
 *
 * The label wording lives in the lib (`locationFreshnessLabel` from
 * `geolocation.ts`, backed by `@pakdam/shared`); this file only formats
 * those labels into the HUD's one-line strings. Nothing here invents a
 * position or a freshness value — every label is computed from a real
 * timestamp the server or the demo store supplied.
 */
import { formatAgeLabel } from '@pakdam/shared';
import { locationFreshnessLabel } from '@/lib/geolocation';
import { ageLabelFromTimestamp } from '@/lib/utils';

/** `0:20 ago` — the age of a ping, from its `createdAt` timestamp. */
export function formatPingAge(createdAtMs: number, nowMs: number = Date.now()): string {
  return ageLabelFromTimestamp(createdAtMs, nowMs);
}

/**
 * `Last fix 0:20 ago` / `Location unknown` / `Location never reported` —
 * the lib's label for a player's last fix, from its timestamp (or null).
 */
export function formatFixFreshness(
  lastFixAtMs: number | null,
  nowMs: number = Date.now(),
): string {
  return locationFreshnessLabel(lastFixAtMs, nowMs);
}

/**
 * The suspended line, exactly as the HUD shows it:
 * `Suspended — location unknown · Last fix 0:20 ago`
 * (or `· Location never reported` when no fix ever arrived).
 */
export function formatSuspendedLabel(
  lastFixAtMs: number | null,
  nowMs: number = Date.now(),
): string {
  return `Suspended — location unknown · ${formatFixFreshness(lastFixAtMs, nowMs)}`;
}

/** Outside-zone countdown as `00:26` (never negative). */
export function formatOutsideCountdown(secondsRemaining: number): string {
  return formatAgeLabel(Math.max(0, Math.ceil(secondsRemaining)));
}

/** `27:07` — a match clock from milliseconds remaining (never negative). */
export function formatTimeLeft(msRemaining: number): string {
  return formatAgeLabel(Math.max(0, Math.floor(msRemaining / 1000)));
}
