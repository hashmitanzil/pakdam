import test from 'node:test';
import assert from 'node:assert/strict';
import { alarmTick } from '../src/room-do.js';
import type { RoomDoState } from '../src/room-do.js';
import {
  scalePolygonTowardCentroid, polygonFullyInside, polygonCentroid,
  haversineMeters, MIN_NEXT_ZONE_OFFSET_M,
} from '@pakdam/engine';
import type { Player, Room } from '@pakdam/shared';

// Pins the alarm-loop rules the founder decided (Step 1c, 2026-11-17):
// HEAD_START flips to ACTIVE at the configured head start; a runner
// 30 s outside the zone is ejected; a poor-GPS pause freezes the
// countdown (accumulated seconds stay, no new seconds accrue); a
// zone shrink emits a redacted ZONE_UPDATED game event.
// Builders mirror workers.test.ts (mkState/mkRoom/mkPlayer/mkTimedState)
// so this file runs standalone.

const mkRoom = (): Room => ({
  roomId: 'r1', roomCode: 'ABC123', hostPlayerId: 'h1', phase: 'ACTIVE',
  version: 3, config: {} as never, createdAt: new Date().toISOString(),
  startedAt: null, endsAt: null, pausedAt: null, result: null,
});
const mkPlayer = (id: string, isHost = false): Player => ({
  playerId: id, roomId: 'r1', kind: isHost ? 'host-account' : 'guest', displayName: id,
  isHost, matchRole: isHost ? 'hunter' : 'runner', team: isHost ? 'hunters' : 'runners',
  reconnectTokenHash: `hash-${id}`, joinedAt: new Date().toISOString(),
  leftAt: null, connectionState: 'connected', lastFixAt: null,
  locationQuality: 'unknown', isReady: true, briefingConfirmed: true,
  ageGatePassed: true, suspensionCount: 0, ejectedAt: null,
});
const mkState = (): RoomDoState => ({
  room: mkRoom(), players: [mkPlayer('h1', true), mkPlayer('r1')],
  latestFix: {}, outsideSinceMs: {}, outsideAccumMs: {},
  lastZoneBoundary: null, gameEventLog: [], pendingPings: [],
  catches: [], activeCatchIds: [], serverSeq: 9, paused: false,
  pausedBy: null, pausedFrom: null, sosActive: false, eventLog: [],
  idempotency: [], hostTokens: {}, lastPingAtMs: {}, wsTickets: [], wsRate: {},
});
const mkTimedState = (phase: 'ACTIVE' | 'HEAD_START', configOver: Record<string, unknown> = {}): RoomDoState => ({
  ...mkState(),
  room: {
    ...mkRoom(), phase,
    startedAt: new Date(1000).toISOString(), endsAt: new Date(1000 + 600_000).toISOString(),
    config: {
      mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
      durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 180,
      zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
      catchConfirmationRequired: true, playZoneEnabled: true,
      balanceHunters: true, randomDraw: true,
      zone: { boundary: [], shrinkPhases: [] }, safeAreas: [], noGoAreas: [],
      selectedHunterIds: [], hostOnSiteConfirmed: true, ...configOver,
    } as never,
  },
});

test('alarm: HEAD_START flips to ACTIVE at the configured head start — not before, not after', () => {
  const state = mkTimedState('HEAD_START');
  // startedAt is 1000 ms, headStartSeconds is 60: the flip is at 61_000.
  assert.equal(alarmTick(state, 1000 + 59_000).state.room.phase, 'HEAD_START');
  const flipped = alarmTick(state, 1000 + 60_000);
  assert.equal(flipped.state.room.phase, 'ACTIVE');
  assert.ok(flipped.messages.length >= 1, 'the flip broadcasts room state');
});

test('alarm: a runner 30 s outside the zone is ejected; 29 s is not', () => {
  const nowMs = 1000 + 300_000; // mid-match, well before endsAt (601_000)
  const at29 = mkTimedState('ACTIVE');
  at29.outsideSinceMs = { r1: nowMs - 29_000 };
  const kept = alarmTick(at29, nowMs);
  assert.equal(kept.state.players.find((p) => p.playerId === 'r1')?.ejectedAt, null);

  const at30 = mkTimedState('ACTIVE');
  at30.outsideSinceMs = { r1: nowMs - 30_000 };
  const tick = alarmTick(at30, nowMs);
  const runner = tick.state.players.find((p) => p.playerId === 'r1');
  assert.ok(runner?.ejectedAt, 'ejectedAt is set at 30 s');
  assert.ok(tick.messages.some((m) => m.type === 'player.removed'), 'a player.removed broadcast goes out');
  const ejected = tick.state.gameEventLog.find(
    (e) => e.type === 'PLAYER_DISCONNECTED' && (e.payload as Record<string, unknown>).reason === 'ejected',
  );
  assert.ok(ejected, 'the ejection is in the redacted game-event log');
});

test('alarm: a poor-GPS pause freezes the countdown — accumulated seconds stay, none accrue', () => {
  const nowMs = 1000 + 300_000;
  // 20 s banked while paused, no live segment: still 20 s, no ejection.
  const paused = mkTimedState('ACTIVE');
  paused.outsideAccumMs = { r1: 20_000 };
  const kept = alarmTick(paused, nowMs);
  assert.equal(kept.state.players.find((p) => p.playerId === 'r1')?.ejectedAt, null);
  assert.equal(kept.state.outsideAccumMs['r1'], 20_000, 'paused seconds are not wiped');

  // 25 s banked + a fresh 5 s live segment = 30 s: ejection.
  const resumed = mkTimedState('ACTIVE');
  resumed.outsideAccumMs = { r1: 25_000 };
  resumed.outsideSinceMs = { r1: nowMs - 5_000 };
  const tick = alarmTick(resumed, nowMs);
  assert.ok(tick.state.players.find((p) => p.playerId === 'r1')?.ejectedAt, '25 s banked + 5 s live = 30 s, ejected');
});

const perfBase = [
  { lat: 23.34, lng: 85.31 }, { lat: 23.34, lng: 85.33 },
  { lat: 23.36, lng: 85.33 }, { lat: 23.36, lng: 85.31 },
];
const perfShrunk = [
  { lat: 23.345, lng: 85.315 }, { lat: 23.345, lng: 85.325 },
  { lat: 23.355, lng: 85.325 }, { lat: 23.355, lng: 85.315 },
];

test('alarm: a zone shrink emits zone.update AND a redacted ZONE_UPDATED game event', () => {
  const nowMs = Date.now();
  const state: RoomDoState = {
    ...mkState(),
    room: {
      ...mkRoom(), phase: 'ACTIVE' as const,
      startedAt: new Date(nowMs - 301_000).toISOString(), endsAt: null,
      config: { playZoneEnabled: true, zone: { boundary: perfBase, shrinkPhases: [{ atSeconds: 300, boundary: perfShrunk }] } } as never,
    },
    lastZoneBoundary: perfBase,
  };
  const tick = alarmTick(state, nowMs);
  assert.ok(tick.messages.some((m) => m.type === 'zone.update'), 'zone.update broadcast');
  const logged = tick.state.gameEventLog.find((e) => e.type === 'ZONE_UPDATED');
  assert.ok(logged, 'ZONE_UPDATED is in the redacted game-event log');
  const payload = logged!.payload as Record<string, unknown>;
  assert.equal(payload.reason, 'shrink');
  assert.ok(!('boundary' in payload), 'the redacted event carries no boundary coordinates');
  assert.equal(payload.pointCount, 4);
});

// --- Server-generated pings (Worker 5, 2026-11-17 — the DO never
// generated pings before: buildPing existed but nothing called it) ---

const mkFix = (playerId: string, atMs: number) => ({
  playerId, roomId: 'r1', lat: 23.35, lng: 85.32, accuracyMeters: 8,
  capturedAt: new Date(atMs).toISOString(), receivedAt: new Date(atMs).toISOString(), quality: 'good' as const,
});

test('alarm: one coarse ping per Runner with a fix, every pingIntervalSeconds — never without a fix', () => {
  // startedAt 1000, interval 180 s: the first ping is due at 181_000.
  const nowMs = 1000 + 180_000;
  const state = mkTimedState('ACTIVE');
  state.latestFix = { r1: mkFix('r1', nowMs - 1000) };
  const tick = alarmTick(state, nowMs);
  const pings = tick.messages.filter((m) => m.type === 'ping');
  assert.equal(pings.length, 1, 'exactly one ping: r1 has a fix (h1 is a Hunter, never pinged)');
  const payload = (pings[0] as { payload?: { ping?: { subjectPlayerId?: string; recipientRole?: string; uncertainty?: unknown } } }).payload?.ping;
  assert.equal(payload?.subjectPlayerId, 'r1');
  assert.equal(payload?.recipientRole, 'hunters');
  assert.ok(payload?.uncertainty && typeof payload.uncertainty === 'object' && 'radiusMeters' in payload.uncertainty);
  assert.equal(tick.state.lastPingAtMs?.['r1'], nowMs, 'the schedule remembers the ping');
  // One second later: nothing new is due — the tick is quiet again.
  const again = alarmTick(tick.state, nowMs + 1000);
  assert.deepEqual(again.messages.filter((m) => m.type === 'ping'), []);
  assert.equal(again.state, tick.state, 'a quiet tick returns the same state object');
});

test('alarm: no pings when the interval is 0, in HEAD_START, with the zone off, or with no fix', () => {
  const nowMs = 1000 + 180_000;
  const withFix = (s: RoomDoState) => { s.latestFix = { r1: mkFix('r1', nowMs - 1000) }; return s; };
  assert.deepEqual(
    alarmTick(withFix(mkTimedState('ACTIVE', { pingIntervalSeconds: 0 })), nowMs).messages.filter((m) => m.type === 'ping'),
    [], 'interval 0 = pings off',
  );
  // HEAD_START at 31 s: the 60 s head start has NOT flipped yet, so
  // Hunters get no locations while Runners are hiding. (A tick at
  // 181_000 would flip to ACTIVE first and then legitimately ping.)
  const headStartState = mkTimedState('HEAD_START');
  headStartState.latestFix = { r1: mkFix('r1', 30_000) };
  assert.deepEqual(
    alarmTick(headStartState, 1000 + 30_000).messages.filter((m) => m.type === 'ping'),
    [], 'no locations for Hunters while Runners are hiding',
  );
  assert.deepEqual(
    alarmTick(withFix(mkTimedState('ACTIVE', { playZoneEnabled: false })), nowMs).messages.filter((m) => m.type === 'ping'),
    [], 'no zone = no pings, classic hide and seek',
  );
  assert.deepEqual(
    alarmTick(mkTimedState('ACTIVE'), nowMs).messages.filter((m) => m.type === 'ping'),
    [], 'no fix = no ping, never an invented position',
  );
  // Before the first interval elapses, nothing is due.
  assert.deepEqual(
    alarmTick(withFix(mkTimedState('ACTIVE')), 1000 + 179_000).messages.filter((m) => m.type === 'ping'),
    [], 'the first ping lands one interval after the match started',
  );
});

// --- Next zone is drawn per shrink, by the server (2026-11-17) ---
//
// The stored shrink-phase boundary (drawn by the host client at
// creation) is only a SIZE placeholder: when the shrink fires, the DO
// re-draws the position from the boundary in force. This test pins
// that with a stored boundary that is EXACTLY concentric — if the DO
// trusted the stored draw, the emitted boundary would equal it.

test('alarm: a zone shrink is re-drawn by the DO per shrink — never the stored host-drawn boundary', () => {
  const nowMs = Date.now();
  // The stored phase boundary is the concentric 75% copy: the one
  // outcome the founder rule ("never concentric") forbids.
  const storedConcentric = scalePolygonTowardCentroid(perfBase, 0.75);
  const state: RoomDoState = {
    ...mkState(),
    room: {
      ...mkRoom(), phase: 'ACTIVE' as const,
      startedAt: new Date(nowMs - 301_000).toISOString(), endsAt: null,
      config: { playZoneEnabled: true, zone: { boundary: perfBase, shrinkPhases: [{ atSeconds: 300, boundary: storedConcentric }] } } as never,
    },
    lastZoneBoundary: perfBase,
  };
  const tick = alarmTick(state, nowMs);
  const update = tick.messages.find((m) => m.type === 'zone.update');
  assert.ok(update, 'zone.update broadcast');
  assert.equal(update.type, 'zone.update');
  const drawn = (update as { payload?: { zone?: { shrinkPhases?: { boundary: unknown }[] } } }).payload?.zone?.shrinkPhases?.[0]?.boundary as { lat: number; lng: number }[];
  assert.ok(drawn, 'the update carries the drawn phase boundary');
  assert.notDeepEqual(drawn, storedConcentric, 'the live boundary is NOT the stored host-drawn one');
  assert.ok(polygonFullyInside(drawn, perfBase), 'the drawn zone sits fully inside the current zone');
  const baseCentre = polygonCentroid(perfBase)!;
  const drawnCentre = polygonCentroid(drawn)!;
  assert.ok(
    haversineMeters(baseCentre, drawnCentre) > MIN_NEXT_ZONE_OFFSET_M,
    `the drawn zone is offset from the centre by more than ${MIN_NEXT_ZONE_OFFSET_M} m (never concentric)`,
  );
  // The drawn boundary replaces the stored one in the room config, so
  // snapshots, previews and later ticks all agree on it.
  assert.deepEqual(tick.state.room.config.zone.shrinkPhases[0]!.boundary, drawn, 'the stored phase is replaced by the drawn boundary');
  assert.deepEqual(tick.state.lastZoneBoundary, drawn);
  // The logged event is still redacted (no boundary coordinates).
  const logged = tick.state.gameEventLog.find((e) => e.type === 'ZONE_UPDATED');
  assert.ok(logged, 'ZONE_UPDATED is in the redacted game-event log');
  assert.ok(!('boundary' in (logged!.payload as Record<string, unknown>)), 'the redacted event carries no boundary coordinates');
  // One second later: no second shrink, no second draw.
  const again = alarmTick(tick.state, nowMs + 1000);
  assert.deepEqual(again.messages.filter((m) => m.type === 'zone.update'), [], 'no second zone.update one second later');
  assert.equal(again.state, tick.state, 'a quiet tick returns the same state object');
});

// --- B-P3-01 (Worker 4 fix, 2026-11-18): no spurious zone.update on
// the first alarm tick -----------------------------------------------
//
// Before the fix, lastZoneBoundary stayed null on a fresh room, so the
// first tick compared the UNCHANGED base boundary against null and
// emitted a spurious zone.update (phase 0, unchanged boundary). The
// fix seeds the baseline twice: startMatch seeds it at match start,
// and alarmTick seeds it silently when it meets a null baseline with
// no shrink fired (e.g. after a recovery). These tests pin both halves
// of that: a null baseline with no shrink fired stays quiet and seeds,
// while a null baseline WITH a shrink already fired (recovery after a
// shrink) still emits — drawn by the DO, never the stored placeholder.

test('alarm (B-P3-01): first tick with a null zone baseline and no shrink fired emits nothing — it seeds the baseline silently', () => {
  // startedAt is 1000 ms; 10 s in, no shrink scheduled at all.
  const state = mkTimedState('ACTIVE', { zone: { boundary: perfBase, shrinkPhases: [] } });
  const tick = alarmTick(state, 1000 + 10_000);
  assert.deepEqual(tick.messages, [], 'the first tick is fully quiet — no spurious zone.update for an unchanged boundary');
  assert.equal(tick.state.gameEventLog.find((e) => e.type === 'ZONE_UPDATED'), undefined, 'no ZONE_UPDATED event for a shrink that never fired');
  assert.deepEqual(tick.state.lastZoneBoundary, perfBase, 'the baseline is seeded with the base boundary');
  // The next tick is quiet in the strong sense: same state object.
  const again = alarmTick(tick.state, 1000 + 11_000);
  assert.deepEqual(again.messages, [], 'no zone.update one second later either');
  assert.equal(again.state, tick.state, 'a quiet tick returns the same state object');
});

test('alarm (B-P3-01): first tick after a recovery (null baseline) with a shrink already fired still emits zone.update — drawn by the DO', () => {
  const nowMs = Date.now();
  // A shrink fired while hibernating: the stored phase is the
  // concentric 75% copy (size placeholder only), and the baseline is
  // null because lastZoneBoundary is NOT recovered.
  const storedConcentric = scalePolygonTowardCentroid(perfBase, 0.75);
  const state: RoomDoState = {
    ...mkState(),
    room: {
      ...mkRoom(), phase: 'ACTIVE' as const,
      startedAt: new Date(nowMs - 301_000).toISOString(), endsAt: null,
      config: { playZoneEnabled: true, zone: { boundary: perfBase, shrinkPhases: [{ atSeconds: 300, boundary: storedConcentric }] } } as never,
    },
    lastZoneBoundary: null,
  };
  const tick = alarmTick(state, nowMs);
  const update = tick.messages.find((m) => m.type === 'zone.update');
  assert.ok(update, 'the missed shrink still emits zone.update on wake');
  const drawn = (update as { payload?: { zone?: { shrinkPhases?: { boundary: unknown }[] } } }).payload?.zone?.shrinkPhases?.[0]?.boundary as { lat: number; lng: number }[];
  assert.ok(drawn, 'the update carries the drawn phase boundary');
  assert.notDeepEqual(drawn, storedConcentric, 'the live boundary is NOT the stored host-drawn placeholder');
  assert.ok(polygonFullyInside(drawn, perfBase), 'the drawn zone sits fully inside the current zone');
  const baseCentre = polygonCentroid(perfBase)!;
  const drawnCentre = polygonCentroid(drawn)!;
  assert.ok(
    haversineMeters(baseCentre, drawnCentre) > MIN_NEXT_ZONE_OFFSET_M,
    `the drawn zone is offset from the centre by more than ${MIN_NEXT_ZONE_OFFSET_M} m (never concentric)`,
  );
  assert.deepEqual(tick.state.lastZoneBoundary, drawn, 'the baseline is seeded with the drawn boundary');
});
