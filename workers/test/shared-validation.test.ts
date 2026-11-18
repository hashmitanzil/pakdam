import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGameEvent, safeParseGameEvent, createGameEvent, dedupeEvents,
  filterNewEvents, redactForLog, redactForSnapshot, GAME_EVENT_TYPES,
  type GameEvent,
} from '@pakdam/shared';
import {
  validateFix, verifyCatchProximity, canAutoCentreZone,
  MAX_PLAUSIBLE_SPEED_MPS,
} from '@pakdam/shared';
import { validateRoomConfig } from '@pakdam/shared';
import { generateRoomCode, OUTSIDE_ZONE_RETURN_SECONDS } from '@pakdam/shared';

// --- Validated game events (founder-approved final stack) ------------

const validEvent = () => createGameEvent('MATCH_STARTED', 'r1', 'h1', {
  mode: 'classic', hunterIds: ['h1'], headStartSeconds: 180, durationSeconds: 3600,
});

test('events: all 10 event types parse, and createGameEvent stamps id + timestamp', () => {
  assert.equal(GAME_EVENT_TYPES.length, 10);
  for (const type of GAME_EVENT_TYPES) {
    assert.equal(typeof type, 'string');
  }
  const e = validEvent();
  assert.equal(e.type, 'MATCH_STARTED');
  assert.equal(typeof e.id, 'string');
  assert.ok(e.id.length >= 30, 'event id is a UUID');
  assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
  // The shim's parse stamps optional keys it was given (seq: undefined
  // when absent), so compare field-by-field, not by deepEqual.
  const parsed = parseGameEvent(e);
  assert.equal(parsed.id, e.id);
  assert.equal(parsed.type, e.type);
  assert.deepEqual(parsed.payload, e.payload);
});

test('events: malformed events are rejected — unknown type, bad UUID, missing payload field, unknown key', () => {
  const e = validEvent() as unknown as Record<string, unknown>;
  assert.throws(() => parseGameEvent({ ...e, type: 'BOGUS' }));
  assert.throws(() => parseGameEvent({ ...e, id: 'not-a-uuid' }));
  assert.throws(() => parseGameEvent({
    ...e, payload: { mode: 'classic', hunterIds: ['h1'], headStartSeconds: 180 },
  }), 'durationSeconds is required');
  assert.throws(() => parseGameEvent({ ...e, surpriseKey: 1 }), 'strict object rejects unknown keys');
  assert.equal(safeParseGameEvent({ ...e, type: 'BOGUS' }).success, false);
  assert.equal(safeParseGameEvent(e).success, true);
});

test('events: dedupe drops a retried event id and keeps first-seen order; filterNewEvents uses a seen set', () => {
  const a = createGameEvent('PLAYER_READY', 'r1', 'p1', { playerId: 'p1' });
  const b = createGameEvent('PLAYER_READY', 'r1', 'p2', { playerId: 'p2' });
  const dup = { ...a };
  assert.deepEqual(dedupeEvents([a, b, dup]).map((x) => x.id), [a.id, b.id]);
  const seen = new Set<string>([a.id]);
  assert.deepEqual(filterNewEvents([a, b], seen).map((x) => x.id), [b.id]);
});

test('events: redactForLog strips raw coordinates — the position never reaches a log', () => {
  const loc = createGameEvent('LOCATION_UPDATED', 'r1', 'p1', {
    fix: { lat: 23.35, lng: 85.32, accuracyMeters: 8, at: new Date().toISOString() },
    quality: 'good',
  });
  const redacted = redactForLog(loc);
  const payload = redacted.payload as Record<string, unknown>;
  assert.equal(payload.quality, 'good');
  assert.equal(payload.accuracyMeters, 8);
  assert.ok(!('lat' in payload) && !('lng' in payload) && !('fix' in payload));
  // The redacted payload serialises with no coordinate anywhere.
  assert.ok(!JSON.stringify(redacted).includes('23.35'));

  const ping = createGameEvent('LOCATION_PING_SENT', 'r1', 'h1', {
    pingId: crypto.randomUUID(), runnerId: 'p1',
    areaLabel: '~120 m north', distanceMeters: 120, bearingDegrees: 10,
  });
  const pingPayload = redactForLog(ping).payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(pingPayload).sort(), ['areaLabel', 'pingId', 'runnerId']);

  const zone = createGameEvent('ZONE_UPDATED', 'r1', 'h1', {
    boundary: [{ lat: 23.35, lng: 85.32 }, { lat: 23.35, lng: 85.33 }, { lat: 23.36, lng: 85.33 }],
    reason: 'shrink', shrinkStep: 1,
  });
  const zonePayload = redactForLog(zone).payload as Record<string, unknown>;
  assert.equal(zonePayload.reason, 'shrink');
  assert.equal(zonePayload.pointCount, 3);
  assert.ok(!('boundary' in zonePayload));
});

test('events: redactForSnapshot is the log redaction plus no seq', () => {
  const e = { ...validEvent(), seq: 7 } as GameEvent;
  const snap = redactForSnapshot(e);
  assert.ok(!('seq' in snap));
  assert.equal(snap.type, 'MATCH_STARTED');
});

// --- GPS validation (generous thresholds, warn before punishing) -----

const fix = (over: Record<string, unknown> = {}) => ({
  lat: 23.35, lng: 85.32, accuracyMeters: 8,
  at: new Date(100_000).toISOString(), ...over,
});
const now = new Date(100_000);

test('gps: a good fix is accepted; a fair fix is accepted with fair quality', () => {
  assert.deepEqual(validateFix(fix(), { now }), {
    verdict: 'accept', quality: 'good', issues: [], speedMps: null,
  });
  const fair = validateFix(fix({ accuracyMeters: 20 }), { now });
  assert.equal(fair.verdict, 'accept');
  assert.equal(fair.quality, 'fair');
});

test('gps: poor accuracy warns, never rejects — an honest indoor player is not punished', () => {
  const poor = validateFix(fix({ accuracyMeters: 60 }), { now });
  assert.equal(poor.verdict, 'warn');
  assert.equal(poor.quality, 'poor');
  assert.ok(poor.issues[0]?.includes('poor'));
});

test('gps: malformed fixes are rejected — out-of-range lat/lng, bad accuracy, bad timestamp', () => {
  assert.equal(validateFix(fix({ lat: 91 }), { now }).verdict, 'reject');
  assert.equal(validateFix(fix({ lng: 181 }), { now }).verdict, 'reject');
  assert.equal(validateFix(fix({ accuracyMeters: 0 }), { now }).verdict, 'reject');
  assert.equal(validateFix(fix({ accuracyMeters: -5 }), { now }).verdict, 'reject');
  assert.equal(validateFix(fix({ at: 'not-a-date' }), { now }).verdict, 'reject');
});

test('gps: future beyond 5 min and stale beyond 60 s are rejected', () => {
  const future = validateFix(fix({ at: new Date(100_000 + 6 * 60_000).toISOString() }), { now });
  assert.equal(future.verdict, 'reject');
  assert.ok(future.issues[0]?.includes('future'));
  const stale = validateFix(fix({ at: new Date(100_000 - 61_000).toISOString() }), { now });
  assert.equal(stale.verdict, 'reject');
  assert.ok(stale.issues[0]?.includes('stale'));
});

test('gps: an exact duplicate of the previous fix is rejected', () => {
  const prev = { lat: 23.35, lng: 85.32, accuracyMeters: 8, at: new Date(100_000).toISOString() };
  const dup = validateFix(fix(), { now, previous: prev });
  assert.equal(dup.verdict, 'reject');
  assert.ok(dup.issues[0]?.includes('duplicate'));
  // Same place, different time is NOT a duplicate.
  const moved = validateFix(fix({ at: new Date(101_000).toISOString() }), { now, previous: prev });
  assert.equal(moved.verdict, 'accept');
});

test('gps: impossible movement warns (never rejects) and reports the speed', () => {
  const prev = { lat: 23.35, lng: 85.32, accuracyMeters: 8, at: new Date(100_000).toISOString() };
  // ~1 km north in 10 s — about 100 m/s, far over the 30 m/s limit.
  const jump = validateFix(
    fix({ lat: 23.359, at: new Date(110_000).toISOString() }),
    { now: new Date(110_000), previous: prev },
  );
  assert.equal(jump.verdict, 'warn');
  assert.ok((jump.speedMps ?? 0) > MAX_PLAUSIBLE_SPEED_MPS);
  assert.ok(jump.issues[0]?.includes('impossible movement'));
});

test('gps: catch proximity is plausibility only — near is plausible, far is not', () => {
  const near = verifyCatchProximity({ lat: 23.35, lng: 85.32 }, { lat: 23.35005, lng: 85.32 });
  assert.equal(near.plausible, true);
  assert.ok(near.distanceMeters < 15);
  const far = verifyCatchProximity({ lat: 23.35, lng: 85.32 }, { lat: 23.36, lng: 85.32 });
  assert.equal(far.plausible, false);
  assert.ok(far.distanceMeters > 1000);
});

test('gps: only a fix within ±50 m may auto-centre the zone (founder rule)', () => {
  assert.equal(canAutoCentreZone(8), true);
  assert.equal(canAutoCentreZone(50), true);
  assert.equal(canAutoCentreZone(51), false);
  assert.equal(canAutoCentreZone(2500), false);
  assert.equal(canAutoCentreZone(null), false);
  assert.equal(canAutoCentreZone(undefined), false);
  assert.equal(canAutoCentreZone(0), false);
  assert.equal(canAutoCentreZone(Number.NaN), false);
});

// --- Room config: 3–30 players (founder, 2026-11-17) ----------------

const validConfig = () => ({
  mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
  durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 180,
  zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
  catchConfirmationRequired: true, playZoneEnabled: true,
  balanceHunters: true, randomDraw: true,
  zone: {
    boundary: [
      { lat: 23.35, lng: 85.32 }, { lat: 23.35, lng: 85.325 },
      { lat: 23.355, lng: 85.325 }, { lat: 23.355, lng: 85.32 },
    ],
    shrinkPhases: [],
  },
  safeAreas: [], noGoAreas: [], selectedHunterIds: [],
  hostOnSiteConfirmed: true,
});
/** validateRoomConfig takes a RoomConfig; the overrides below are
 *  deliberately invalid values, so the cast sits at the call site. */
const check = (over: Partial<ReturnType<typeof validConfig>> = {}) =>
  validateRoomConfig({ ...validConfig(), ...over } as never);

test('config: 30 players is valid, 31 is rejected, 2 is rejected, 3 is valid', () => {
  assert.deepEqual(check(), []);
  assert.ok(check({ maxPlayers: 31 }).some((e) => e.includes('3–30')));
  assert.ok(check({ maxPlayers: 2 }).some((e) => e.includes('3–30')));
  assert.deepEqual(check({ maxPlayers: 3 }), []);
});

test('config: Zombie/Breach are not modes — Classic + Infection only', () => {
  assert.ok(check({ mode: 'zombie' }).some((e) => e.includes('mode must be')));
  assert.ok(check({ mode: 'breach' }).some((e) => e.includes('mode must be')));
  assert.deepEqual(check({ mode: 'infection' }), []);
});

test('config: hunterCount must be >= 1 and < maxPlayers', () => {
  assert.ok(check({ hunterCount: 0 }).some((e) => e.includes('hunterCount')));
  assert.ok(check({ hunterCount: 30 }).some((e) => e.includes('hunterCount')));
});

// --- Room codes: crypto, not guessable --------------------------------

test('room codes: 6 chars from the 32-char alphabet, no 0/O/1/I, and distinct', () => {
  const a = generateRoomCode();
  const b = generateRoomCode();
  assert.equal(a.length, 6);
  assert.match(a, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(!/[01IO]/.test(a));
  assert.notEqual(a, b, 'two codes from crypto randomness must differ');
});

test('outside-zone rule: the return countdown is a fixed 30 seconds, then ejection', () => {
  assert.equal(OUTSIDE_ZONE_RETURN_SECONDS, 30);
});
