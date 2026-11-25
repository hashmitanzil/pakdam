import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  haversineMeters,
  validateFix,
  canAutoCentreZone,
  isFixSendable,
  locationStatusForPlayer,
  locationFreshnessLabel,
  formatAgeLabel,
  verifyCatchProximity,
} = await import('../src/gps-validation.ts');

const NOW = 1_000_000;
const fix = (overrides = {}) => ({
  lat: 23.35,
  lng: 85.33,
  accuracyMeters: 8,
  timestampMs: NOW,
  ...overrides,
});

test('haversine: the same point is 0 m apart', () => {
  assert.equal(
    haversineMeters({ lat: 23.35, lng: 85.33 }, { lat: 23.35, lng: 85.33 }),
    0,
  );
});

test('haversine: one degree of latitude is ~111,195 m', () => {
  const d = haversineMeters({ lat: 23.35, lng: 85.33 }, { lat: 24.35, lng: 85.33 });
  assert.ok(Math.abs(d - 111194.93) < 1, `got ${d}`);
});

test('haversine: symmetric, and Ranchi–Patna is ~250 km', () => {
  const ranchi = { lat: 23.3441, lng: 85.3096 };
  const patna = { lat: 25.5941, lng: 85.1376 };
  assert.equal(haversineMeters(ranchi, patna), haversineMeters(patna, ranchi));
  const d = haversineMeters(ranchi, patna);
  assert.ok(d > 200_000 && d < 300_000, `got ${d}`);
});

test('validateFix: a good fresh fix passes with quality good', () => {
  const r = validateFix(fix(), null, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.quality, 'good');
  assert.equal(r.code, null);
  assert.deepEqual(r.errors, []);
});

test('validateFix: latitude outside ±90 is rejected as VALIDATION_FAILED', () => {
  const r = validateFix(fix({ lat: 91 }), null, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VALIDATION_FAILED');
  assert.equal(r.quality, null);
});

test('validateFix: accuracy worse than ±1000 m is rejected', () => {
  const r = validateFix(fix({ accuracyMeters: 1500 }), null, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VALIDATION_FAILED');
});

test('validateFix: a fix older than 60 s is STALE_LOCATION', () => {
  const r = validateFix(fix({ timestampMs: NOW - 61_000 }), null, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STALE_LOCATION');
});

test('validateFix: a timestamp >5 min in the future is clock skew, not stale', () => {
  const r = validateFix(fix({ timestampMs: NOW + 300_001 }), null, NOW);
  assert.equal(r.ok, false);
  // v34 (Diya R2-6) — the future-dated rejection carries the distinct
  // CLOCK_SKEW code so the client can warn about the phone clock.
  assert.equal(r.code, 'CLOCK_SKEW');
});

test('validateFix: an exact duplicate of the previous fix is rejected', () => {
  const r = validateFix(fix(), fix(), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VALIDATION_FAILED');
});

test('validateFix: poor accuracy warns but still passes', () => {
  const r = validateFix(fix({ accuracyMeters: 30 }), null, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.quality, 'poor');
  assert.equal(r.warnings.length, 1);
});

test('validateFix: impossible movement warns but still passes', () => {
  const prev = fix({ timestampMs: NOW - 1000 });
  const r = validateFix(fix({ lat: 23.359 }), prev, NOW);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('impossible movement')));
});

test('±50 m rule: 50 m can auto-centre and be sent, 51 m cannot', () => {
  assert.equal(canAutoCentreZone(fix({ accuracyMeters: 50 })), true);
  assert.equal(canAutoCentreZone(fix({ accuracyMeters: 51 })), false);
  assert.equal(isFixSendable(fix({ accuracyMeters: 50 })), true);
  assert.equal(isFixSendable(fix({ accuracyMeters: 51 })), false);
});

test('location status: null is unknown, fresh is known, 31 s old is unknown', () => {
  assert.equal(locationStatusForPlayer(null, NOW), 'unknown');
  assert.equal(locationStatusForPlayer(NOW - 20_000, NOW), 'known');
  assert.equal(locationStatusForPlayer(NOW - 31_000, NOW), 'unknown');
});

test('freshness labels and age formatting', () => {
  assert.equal(locationFreshnessLabel(null, NOW), 'Location never reported');
  assert.equal(locationFreshnessLabel(NOW - 40_000, NOW), 'Location unknown');
  assert.equal(locationFreshnessLabel(NOW - 20_000, NOW), 'Last fix 0:20 ago');
  assert.equal(formatAgeLabel(0), '0:00');
  assert.equal(formatAgeLabel(20), '0:20');
  assert.equal(formatAgeLabel(125), '2:05');
});

test('verifyCatchProximity: 0 m and ~10 m are plausible, ~100 m is not', () => {
  const hunter = fix();
  assert.equal(verifyCatchProximity(hunter, fix()).distanceMeters, 0);
  assert.equal(verifyCatchProximity(hunter, fix()).plausible, true);
  assert.equal(verifyCatchProximity(hunter, fix({ lat: 23.35009 })).plausible, true);
  assert.equal(verifyCatchProximity(hunter, fix({ lat: 23.3509 })).plausible, false);
});
