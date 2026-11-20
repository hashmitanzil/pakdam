import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  isValidRoomCode,
  isValidDisplayName,
  isUuid,
  isValidGeoPoint,
  isValidGeoPolygon,
  validateZoneBoundary,
  balancedHunterCount,
  suggestZoneRadiusMeters,
  classifyAccuracy,
  isValidCatchToken,
  helloHasCredential,
} = await import('../src/validation.ts');

test('room code: exactly 6 uppercase alphanumerics', () => {
  assert.equal(isValidRoomCode('ABC123'), true);
  assert.equal(isValidRoomCode('abc123'), false);
  assert.equal(isValidRoomCode('ABC12'), false);
  assert.equal(isValidRoomCode('ABC1234'), false);
  assert.equal(isValidRoomCode('ABC-23'), false);
  assert.equal(isValidRoomCode(123456), false);
  assert.equal(isValidRoomCode(''), false);
});

test('display name: 1–30 chars, one visible line', () => {
  assert.equal(isValidDisplayName('Mira'), true);
  assert.equal(isValidDisplayName('Rahul Kumar'), true);
  assert.equal(isValidDisplayName('x'.repeat(30)), true);
  assert.equal(isValidDisplayName(''), false);
  assert.equal(isValidDisplayName('   '), false);
  assert.equal(isValidDisplayName('x'.repeat(31)), false);
  assert.equal(isValidDisplayName('A\nB'), false);
  assert.equal(isValidDisplayName(42), false);
});

test('uuid: v4-shaped, case-insensitive', () => {
  assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(isUuid('123E4567-E89B-12D3-A456-426614174000'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(123), false);
});

test('geo point: lat ±90, lng ±180, finite numbers', () => {
  assert.equal(isValidGeoPoint({ lat: 0, lng: 0 }), true);
  assert.equal(isValidGeoPoint({ lat: 90, lng: 180 }), true);
  assert.equal(isValidGeoPoint({ lat: 90.1, lng: 0 }), false);
  assert.equal(isValidGeoPoint({ lat: 0, lng: -180.1 }), false);
  assert.equal(isValidGeoPoint({ lat: Number.NaN, lng: 0 }), false);
  assert.equal(isValidGeoPoint(null), false);
  assert.equal(isValidGeoPoint({ lat: '0', lng: 0 }), false);
});

test('geo polygon: needs ≥3 valid points', () => {
  const triangle = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.01 },
    { lat: 0.01, lng: 0 },
  ];
  assert.equal(isValidGeoPolygon(triangle), true);
  assert.equal(isValidGeoPolygon(triangle.slice(0, 2)), false);
  assert.equal(isValidGeoPolygon([]), false);
  assert.equal(
    isValidGeoPolygon([...triangle, { lat: 91, lng: 0 }]),
    false,
  );
});

test('zone boundary: empty is allowed unless placed is required', () => {
  assert.deepEqual(validateZoneBoundary([]), []);
  assert.equal(validateZoneBoundary([], { requirePlaced: true }).length, 1);
});

test('zone boundary: fewer than 3 points and more than 64 are rejected', () => {
  const p = { lat: 0, lng: 0 };
  assert.equal(validateZoneBoundary([p, p]).length, 1);
  assert.equal(validateZoneBoundary(Array.from({ length: 65 }, () => p)).length, 1);
});

test('zone boundary: a small valid triangle passes, a planet-spanning one fails', () => {
  const small = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.01 },
    { lat: 0.01, lng: 0 },
  ];
  assert.deepEqual(validateZoneBoundary(small), []);
  const huge = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 2 },
    { lat: 1, lng: 0 },
  ];
  const issues = validateZoneBoundary(huge);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].includes('100 km'), issues[0]);
});

test('balance table: 2–4 → 1, 5–8 → 2, 9–16 → 3, 17–24 → 4, 25–30 → 5', () => {
  assert.equal(balancedHunterCount(2), 1);
  assert.equal(balancedHunterCount(4), 1);
  assert.equal(balancedHunterCount(5), 2);
  assert.equal(balancedHunterCount(8), 2);
  assert.equal(balancedHunterCount(9), 3);
  assert.equal(balancedHunterCount(16), 3);
  assert.equal(balancedHunterCount(17), 4);
  assert.equal(balancedHunterCount(24), 4);
  assert.equal(balancedHunterCount(25), 5);
  assert.equal(balancedHunterCount(30), 5);
  assert.equal(balancedHunterCount(1), 1);
});

test('suggested zone radius: 200 m base, +25 m/player past 3, capped at 1000 m', () => {
  assert.equal(suggestZoneRadiusMeters(2), 200);
  assert.equal(suggestZoneRadiusMeters(3), 200);
  assert.equal(suggestZoneRadiusMeters(7), 300);
  assert.equal(suggestZoneRadiusMeters(11), 400);
  assert.equal(suggestZoneRadiusMeters(35), 1000);
  assert.equal(suggestZoneRadiusMeters(100), 1000);
});

test('accuracy tiers: good ≤10 m, fair ≤25 m, else poor', () => {
  assert.equal(classifyAccuracy(5), 'good');
  assert.equal(classifyAccuracy(10), 'good');
  assert.equal(classifyAccuracy(11), 'fair');
  assert.equal(classifyAccuracy(25), 'fair');
  assert.equal(classifyAccuracy(26), 'poor');
  assert.equal(classifyAccuracy(60), 'poor');
});

test('catch token: only the fresh 32-char uppercase form is valid', () => {
  assert.equal(isValidCatchToken('A'.repeat(32)), true);
  assert.equal(isValidCatchToken('0123456789ABCDEF'.repeat(2)), true);
  assert.equal(isValidCatchToken('a'.repeat(32)), false);
  assert.equal(isValidCatchToken('A'.repeat(31)), false);
  assert.equal(isValidCatchToken('A'.repeat(12)), false);
  assert.equal(isValidCatchToken('G'.repeat(32)), false);
  assert.equal(isValidCatchToken(123), false);
});

test('hello credential scan: finds credential keys at any depth or casing', () => {
  assert.equal(helloHasCredential({}), false);
  assert.equal(helloHasCredential({ name: 'Mira' }), false);
  assert.equal(helloHasCredential(null), false);
  assert.equal(helloHasCredential('token'), false);
  assert.equal(helloHasCredential({ token: 'x' }), true);
  assert.equal(helloHasCredential({ Token: 'x' }), true);
  assert.equal(helloHasCredential({ nested: { password: 'x' } }), true);
  assert.equal(helloHasCredential({ data: ['a', { ticket: 'y' }] }), true);
});
