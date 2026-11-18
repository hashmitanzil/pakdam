/** Fresh-vs-stale helpers (24 §3 S05, 23 §6B). All wording is plain
 *  English; a frozen marker is never shown as live. No coordinates are
 *  produced here — only labels, tiers and bearings derived from values
 *  the caller already holds. */
import type { ConnectionState, GeoPolygon, ZoneConfig } from '@pakdam/shared';
import { effectiveZoneBoundary, nextShrinkPhaseAt } from '@pakdam/engine';

export function minutesAgo(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 0;
  return Math.floor(ms / 60000);
}

export function lastReportedLabel(lastFixAt: string | null): string {
  const m = minutesAgo(lastFixAt);
  if (m === null) return 'Location never reported';
  if (m < 1) return 'Last reported just now';
  if (m === 1) return 'Last reported 1 min ago';
  return `Last reported ${m} min ago`;
}

/** Seconds-aware "last updated" wording for dots and freshness rows:
 *  "Last updated just now", "Last updated 45 s ago", "Last updated
 *  2 min ago". The founder's final location rule (2026-11-17) keeps
 *  this wording on all dots/pings — a frozen marker is never shown as
 *  live, and the age is in seconds while it is fresh. Minute-granular
 *  lastReportedLabel stays for the places that already use it. */
export function lastUpdatedLabel(iso: string | null): string {
  if (!iso) return 'Location never updated';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'Last updated just now';
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'Last updated just now';
  if (s < 60) return `Last updated ${s} s ago`;
  const m = Math.floor(s / 60);
  if (m === 1) return 'Last updated 1 min ago';
  return `Last updated ${m} min ago`;
}

/** Seconds-aware freshness wording for pings: "just now", "45 s ago",
 *  "2 min ago". Same rule as lastReportedLabel — never "live" unless the
 *  report is actually fresh. */
export function pingAgeLabel(reportedAt: string | null): string {
  if (!reportedAt) return 'No ping reported yet';
  const ms = Date.now() - new Date(reportedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'Reported just now';
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'Reported just now';
  if (s < 60) return `Reported ${s} s ago`;
  const m = Math.floor(s / 60);
  if (m === 1) return 'Reported 1 min ago';
  return `Reported ${m} min ago`;
}

/** Fresh = solid marker; stale/suspended = hollow/greyed marker. */
export function freshnessState(connectionState: ConnectionState, lastFixAt: string | null): {
  kind: 'fresh' | 'stale' | 'suspended' | 'unknown';
  label: string;
} {
  if (connectionState === 'suspended') {
    return { kind: 'suspended', label: `Suspended — location unknown · ${lastReportedLabel(lastFixAt)}` };
  }
  if (connectionState === 'disconnected') {
    return { kind: 'unknown', label: `Left / disconnected · ${lastReportedLabel(lastFixAt)}` };
  }
  const m = minutesAgo(lastFixAt);
  if (m === null) return { kind: 'unknown', label: 'Location never reported' };
  if (connectionState === 'stale' || m >= 3) return { kind: 'stale', label: `Stale · ${lastReportedLabel(lastFixAt)}` };
  return { kind: 'fresh', label: `Live · ${lastReportedLabel(lastFixAt)}` };
}

/** Hot/cold tiers (23 §6A). Thresholds are calibration OPEN — the tier
 *  words are the spec's own; no distance is invented by this helper.
 *  Callers pass a distance only when the server/demo actually supplied
 *  one; otherwise they pass null and get the honest "Searching" tier. */
export type HotColdTier = 'Searching' | 'Getting warmer' | 'Warm' | 'Hot' | 'Burning';
export function hotColdTier(distanceMeters: number | null): { tier: HotColdTier; note: string } {
  if (distanceMeters === null) {
    return { tier: 'Searching', note: 'No ping yet — the next scheduled ping will give a coarse area, never an exact pin.' };
  }
  if (distanceMeters > 700) return { tier: 'Searching', note: 'More than 700 m away (tier threshold: calibration OPEN).' };
  if (distanceMeters > 300) return { tier: 'Getting warmer', note: 'Within roughly 300–700 m — coarse area only.' };
  if (distanceMeters > 120) return { tier: 'Warm', note: 'Within roughly 120–300 m — coarse area only.' };
  if (distanceMeters > 40) return { tier: 'Hot', note: 'Within roughly 40–120 m — coarse area only.' };
  return { tier: 'Burning', note: 'Very close — coarse area only. A catch still needs the Runner’s QR code and their confirmation.' };
}

/** 0–4 heat level for the tier meter (0 = Searching … 4 = Burning).
 *  Colour is never the only signal: the tier word is always shown too. */
export function hotColdLevel(distanceMeters: number | null): number {
  if (distanceMeters === null || distanceMeters > 700) return 0;
  if (distanceMeters > 300) return 1;
  if (distanceMeters > 120) return 2;
  if (distanceMeters > 40) return 3;
  return 4;
}

export function bearingWord(degrees: number | null): string {
  if (degrees === null || Number.isNaN(degrees)) return '';
  const dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return dirs[Math.round(((degrees % 360) + 360) % 360 / 45) % 8] ?? '';
}

export function bearingBetween(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(toLng - fromLng);
  const y = Math.sin(dLng) * Math.cos(toRad(toLat));
  const x = Math.cos(toRad(fromLat)) * Math.sin(toRad(toLat)) - Math.sin(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function polygonCentroid(poly: GeoPolygon): { lat: number; lng: number } | null {
  if (poly.length === 0) return null;
  let lat = 0;
  let lng = 0;
  for (const p of poly) { lat += p.lat; lng += p.lng; }
  return { lat: lat / poly.length, lng: lng / poly.length };
}

export function pointInPolygon(lat: number, lng: number, poly: GeoPolygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    const crosses = a.lng > lng !== b.lng > lng && lat < ((b.lat - a.lat) * (lng - a.lng)) / (b.lng - a.lng) + a.lat;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function formatClock(totalSeconds: number): string {
  // Defensive: a non-finite input (e.g. a division by a zero ping
  // interval, or a bad timestamp) must never render as "NaN:NaN" in the
  // HUD — it floors to 0:00 instead. Callers still guard the division
  // itself (nextPingIn is null when pings are off); this is the last line.
  const s = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Ping/dot age in the founder's "0:27 ago" clock (founder decision,
 *  2026-11-17 — a ping stays on the hunter's map until the next ping
 *  replaces it, and its age counts up). Under 10 s it reads "just now";
 *  from 10 s it reads "0:27 ago" (minutes:seconds, counting up). Never
 *  "live" unless the report is actually fresh — the caller pairs it
 *  with a freshness word (Live / Stale). */
export function formatAgeAgo(iso: string | null): string {
  if (!iso) return 'No ping yet';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'just now';
  return `${formatClock(s)} ago`;
}

/** Human distance: "180 m" under 1 km, "1.2 km" above. Rounded, labelled
 *  "about" by callers — GPS distances are approximate, never exact. */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Approximate zone width: the widest distance between any two
 *  boundary points. The boundary is a polygon, not a circle, so this
 *  is an "about" figure for the HUD — never presented as a surveyed
 *  size. Same definition as the engine's zoneDiameterMeters (max
 *  pairwise distance), so the HUD label, the host-setup size text
 *  and the validation range check can never disagree about a zone's
 *  size — the old centroid-based figure differed on irregular drawn
 *  shapes. */
export function zoneDiameterMeters(boundary: GeoPolygon): number | null {
  if (boundary.length < 3) return null;
  let max = 0;
  for (let i = 0; i < boundary.length; i++) {
    for (let j = i + 1; j < boundary.length; j++) {
      max = Math.max(max, haversineMeters(boundary[i]!.lat, boundary[i]!.lng, boundary[j]!.lat, boundary[j]!.lng));
    }
  }
  return max > 0 ? Math.round(max) : null;
}

export function zoneSizeLabel(boundary: GeoPolygon): string {
  const d = zoneDiameterMeters(boundary);
  return d === null ? 'Zone size not available' : `About ${formatDistance(d)} across`;
}

/** Next shrink phase for a zone, given the match start. Returns null
 *  when no shrink is scheduled or all phases have passed. Shared by the
 *  HUD bar and the next-zone panel so the two can never disagree.
 *  Delegates to the engine — the one definition of phase timing. */
export function nextShrinkPhase(
  zone: ZoneConfig,
  startedAt: string | null,
  nowMs: number,
): { atSeconds: number; inSeconds: number | null; boundary: GeoPolygon; totalPhases: number; phaseIndex: number } | null {
  return nextShrinkPhaseAt(zone, startedAt, nowMs);
}

/** The zone boundary in force right now: the latest shrink phase
 *  whose time has passed, else the base boundary. Delegates to the
 *  engine — the one definition of "current zone", shared with the
 *  worker's outside-zone check. */
export function currentZoneBoundary(zone: ZoneConfig, startedAt: string | null, nowMs: number): GeoPolygon {
  return effectiveZoneBoundary(zone, startedAt, nowMs);
}
