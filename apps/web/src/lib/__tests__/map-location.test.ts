import test from 'node:test';
import assert from 'node:assert/strict';
import * as shared from '@pakdam/shared';
import { validateRoomConfig } from '@pakdam/shared';
import type { RoomConfig } from '@pakdam/shared';
import { locationPrecision, locationPrecisionLabel } from '../geolocation.js';
import { hotColdTier } from '../../components/match/freshness.js';

// ---------------------------------------------------------------------------
// Map + location worker — regression tests for the 2026-11-17 map fixes:
// (D-M3) Precise / Approximate location mode in plain words,
// (D-M11) "the Runner's QR code" wording in freshness.ts,
// radius cap removal (founder decision: unlimited past 1 km —
// the old 1.5 km radius / 3 km diameter caps are deleted).
//
// RUNNING: same scratch-compile flow as the other suites in this
// directory (see scripts/test-web-lib.sh header): tsc the sources
// + this file to a scratch dir, fix up extensionless imports, then
// `node --test` the emitted file. This file IS in the script's file
// list (added 2026-11-18) so it runs with the suite.
// ---------------------------------------------------------------------------

/** A ~regular polygon of `radiusM` around (23.36, 85.33) — a zone
 *  boundary with a known diameter of about 2× radius. */
function circleBoundary(radiusM: number): { lat: number; lng: number }[] {
  const pts: { lat: number; lng: number }[] = [];
  for (let i = 0; i < 32; i += 1) {
    const b = (i / 32) * 2 * Math.PI;
    pts.push({
      lat: 23.36 + (radiusM * Math.cos(b)) / 111320,
      lng: 85.33 + (radiusM * Math.sin(b)) / (111320 * Math.cos((23.36 * Math.PI) / 180)),
    });
  }
  return pts;
}

function roomWithBoundary(boundary: { lat: number; lng: number }[]): RoomConfig {
  return {
    mode: 'classic', teamAssignment: 'random', maxPlayers: 6, hunterCount: 2,
    durationSeconds: 1800, headStartSeconds: 180, pingIntervalSeconds: 180,
    zoneShrinkEnabled: true, zoneShrinkIntervalSeconds: 600,
    catchConfirmationRequired: true, balanceHunters: true, randomDraw: true,
    showPingHistory: false, playZoneEnabled: true, huntersCanTalk: true,
    finalSizePercent: null,
    zone: { boundary, shrinkPhases: [] }, zoneShape: 'circle',
    safeAreas: [], noGoAreas: [], selectedHunterIds: [],
    hostOnSiteConfirmed: true,
  };
}

// --- D-M3: Precise / Approximate from the fix accuracy -------------
test('D-M3: a good/fair fix is Precise location', () => {
  assert.equal(locationPrecision(8), 'precise');
  assert.equal(locationPrecision(10), 'precise');
  assert.equal(locationPrecision(25), 'precise');
  assert.equal(locationPrecisionLabel(8), 'Precise location');
  assert.equal(locationPrecisionLabel(25), 'Precise location');
});

test('D-M3: a coarse fix is Approximate location, never Precise', () => {
  assert.equal(locationPrecision(26), 'approximate');
  assert.equal(locationPrecision(2500), 'approximate');
  assert.equal(locationPrecisionLabel(2500), 'Approximate location');
});

test('D-M3: no fix means unknown — the mode is never guessed', () => {
  assert.equal(locationPrecision(null), 'unknown');
  assert.equal(locationPrecision(undefined), 'unknown');
  assert.equal(locationPrecisionLabel(null), 'Location not shared yet');
});

// --- D-M11: QR code wording ----------------------------------------
test('D-M11: the Burning tier says QR code, never a typed code', () => {
  const { note } = hotColdTier(20);
  assert.equal(note.includes('QR code'), true);
  assert.equal(note.includes("Runner’s code"), false);
  assert.equal(note.includes("Runner's code"), false);
});

// --- Radius cap removal --------------------------------------------
test('radius: the 1.5 km cap constant is gone; only the UI range remains', () => {
  assert.equal('ZONE_RADIUS_MAX_M' in shared, false);
  assert.equal(shared.ZONE_RADIUS_MIN_M, 100);
  assert.equal(shared.ZONE_RADIUS_UI_MAX_M, 10000);
  assert.equal(shared.ZONE_RADIUS_DEFAULT_M, 500);
});

test('radius: a 5 km radius zone (10 km across) validates — unlimited past 1 km', () => {
  const errs = validateRoomConfig(roomWithBoundary(circleBoundary(5000)));
  assert.deepEqual(errs, []);
});

test('radius: a 1.5 km radius zone still validates (the old cap edge)', () => {
  const errs = validateRoomConfig(roomWithBoundary(circleBoundary(1500)));
  assert.deepEqual(errs, []);
});

test('radius: the 200 m minimum diameter still enforced', () => {
  const errs = validateRoomConfig(roomWithBoundary(circleBoundary(50)));
  assert.equal(errs.some((e) => e.includes('at least 200 m')), true);
});
