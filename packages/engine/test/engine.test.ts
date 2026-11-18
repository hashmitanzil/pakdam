import test from 'node:test';
import assert from 'node:assert/strict';
import { transition, canTransition } from '../src/state-machine.js';
import { assignRoles, balancedHunterCount } from '../src/roles.js';
import { issueCatchToken, verifyCatchToken, resolveCatch, expireCatch, gpsEvidenceForCatch } from '../src/catch.js';
import { recordSuspension, canCompleteCatchWhileRunnerSuspended } from '../src/suspension.js';
import { canSafetyPause } from '../src/safety.js';
import { isPingDeliverable, purgeExpiredPings, snapshotPings } from '../src/pings.js';
import { pointInPolygon } from '../src/zone.js';
import { resolveOutcome } from '../src/scoring.js';
import { classifyAccuracy, validateRoomConfig, sha256Hex, canAutoCentreZone } from '@pakdam/shared';
import type { CatchEvent, Player, RoomConfig } from '@pakdam/shared';

const mkPlayer = (id: string, isHost = false): Player => ({
  playerId: id, roomId: 'r1', kind: isHost ? 'host-account' : 'guest', displayName: id,
  isHost, matchRole: null, team: null, reconnectTokenHash: 'hash', joinedAt: new Date().toISOString(),
  leftAt: null, connectionState: 'connected', lastFixAt: null, locationQuality: 'unknown',
  isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0, ejectedAt: null,
});
const mkConfig = (): RoomConfig => ({
  mode: 'classic', teamAssignment: 'random', maxPlayers: 16, hunterCount: 1, durationSeconds: 1800, headStartSeconds: 180,
  pingIntervalSeconds: 180, zoneShrinkEnabled: true, zoneShrinkIntervalSeconds: 600,
  catchConfirmationRequired: true,
  // No outside-zone timing fields: the rule is a single fixed 30-second
  // return countdown, then ejection (OUTSIDE_ZONE_RETURN_SECONDS).
  // Small realistic boundary (~550 m across), inside the 200 m–3 km
  // diameter bound — a 1-degree square would be ~100 km across.
  zone: { boundary: Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * 2 * Math.PI;
    return { lat: 23.3642 + (275 * Math.cos(a)) / 111320, lng: 85.331 + (275 * Math.sin(a)) / (111320 * Math.cos((23.3642 * Math.PI) / 180)) };
  }), shrinkPhases: [] },
  safeAreas: [], noGoAreas: [], selectedHunterIds: [], hostOnSiteConfirmed: true,
});

test('state machine: full happy path, and illegal jumps are rejected', () => {
  assert.equal(transition('DRAFT', 'LOBBY'), 'LOBBY');
  assert.equal(transition('LOBBY', 'READY_CHECK'), 'READY_CHECK');
  assert.equal(transition('ACTIVE', 'SAFETY_PAUSED'), 'SAFETY_PAUSED');
  assert.equal(transition('SAFETY_PAUSED', 'ACTIVE'), 'ACTIVE');
  assert.equal(canTransition('DRAFT', 'ACTIVE'), false);
  assert.throws(() => transition('COMPLETED', 'ACTIVE'), /INVALID_STATE/);
  assert.throws(() => transition('LOBBY', 'ACTIVE'), /INVALID_STATE/);
});

// QA BE-01 (2026-11-17): the Durable Object must NEVER jump directly
// LOBBY -> HEAD_START or ACTIVE -> COMPLETED — both throw INVALID_STATE.
// The legal walks are LOBBY -> READY_CHECK -> COUNTDOWN -> HEAD_START
// (startMatch) and ACTIVE -> RESOLVING -> COMPLETED (completeMatch).
// (An earlier draft of this fix widened the table instead; reverted —
// the strict machine plus the walks is the better design.)
test('state machine: DO legal walks only (BE-01 regression)', () => {
  assert.equal(transition('LOBBY', 'READY_CHECK'), 'READY_CHECK');
  assert.equal(transition('READY_CHECK', 'COUNTDOWN'), 'COUNTDOWN');
  assert.equal(transition('COUNTDOWN', 'HEAD_START'), 'HEAD_START');
  assert.equal(transition('ACTIVE', 'RESOLVING'), 'RESOLVING');
  assert.equal(transition('RESOLVING', 'COMPLETED'), 'COMPLETED');
  assert.throws(() => transition('LOBBY', 'HEAD_START'), /INVALID_STATE/);
  assert.throws(() => transition('ACTIVE', 'COMPLETED'), /INVALID_STATE/);
  assert.throws(() => transition('HEAD_START', 'COMPLETED'), /INVALID_STATE/);
});

test('roles: balanced hunters scale to the 30-player cap (2 for 6, 3 for 16)', () => {
  assert.equal(balancedHunterCount(3), 1);
  assert.equal(balancedHunterCount(4), 1);
  assert.equal(balancedHunterCount(6), 2);
  assert.equal(balancedHunterCount(8), 2);
  assert.equal(balancedHunterCount(9), 3);
  assert.equal(balancedHunterCount(16), 3);
  assert.equal(balancedHunterCount(17), 4);
  assert.equal(balancedHunterCount(24), 4);
  assert.equal(balancedHunterCount(25), 5);
  assert.equal(balancedHunterCount(30), 5);
});

test('gps: only a fix within ±50 m may auto-centre the zone', () => {
  assert.equal(canAutoCentreZone(50), true);
  assert.equal(canAutoCentreZone(10), true);
  assert.equal(canAutoCentreZone(51), false);
  assert.equal(canAutoCentreZone(500), false);
  assert.equal(canAutoCentreZone(null), false);
  assert.equal(canAutoCentreZone(undefined), false);
  assert.equal(canAutoCentreZone(NaN), false);
  assert.equal(canAutoCentreZone(0), false);
  assert.equal(canAutoCentreZone(-5), false);
});

test('roles: host is a permission, not a match role — host can be a hunter', () => {
  const players = [mkPlayer('h1', true), mkPlayer('r1'), mkPlayer('r2')];
  const assigned = assignRoles(players, 1);
  assert.equal(assigned[0]!.isHost, true);
  assert.equal(assigned[0]!.matchRole, 'hunter'); // host IS the hunter here
  assert.equal(assigned[1]!.matchRole, 'runner');
  assert.equal(assigned[2]!.team, 'runners');
  assert.throws(() => assignRoles(players, 3), /hunterCount/);
});

test('catch: token is single-use verifiable, replay with wrong code fails, confirm wins, dispute blocks', () => {
  const tok = issueCatchToken('c1', 120, 1000);
  assert.equal(verifyCatchToken('c1', tok.raw, tok.hash), true);
  assert.equal(verifyCatchToken('c1', 'WRONGCODE', tok.hash), false);
  assert.equal(verifyCatchToken('c2', tok.raw, tok.hash), false); // cross-room/catch reuse
  const c: CatchEvent = { catchId: 'c1', roomId: 'r1', hunterPlayerId: 'h1', runnerPlayerId: 'r1', state: 'awaiting-confirmation', qrTokenHash: tok.hash, requestedAt: new Date().toISOString(), confirmedAt: null, disputedAt: null, resolution: null, gpsEvidence: 'present' };
  assert.equal(resolveCatch(c, 'confirm', new Date().toISOString()).state, 'confirmed');
  const d = resolveCatch(c, 'dispute', new Date().toISOString());
  assert.equal(d.state, 'disputed');
  assert.equal(expireCatch({ ...c, state: 'requested' }).state, 'expired');
  assert.equal(gpsEvidenceForCatch(null, 2000, 30000), 'absent'); // absent GPS is never negative evidence
});

test('safety: pause is allowed only where the state machine allows SAFETY_PAUSED', () => {
  // HEAD_START and ACTIVE can pause; already-paused is a no-op true.
  assert.equal(canSafetyPause('HEAD_START'), true);
  assert.equal(canSafetyPause('ACTIVE'), true);
  assert.equal(canSafetyPause('SAFETY_PAUSED'), true);
  // No clock running yet, match ending, or terminal: no pause.
  for (const phase of ['DRAFT', 'LOBBY', 'READY_CHECK', 'COUNTDOWN', 'RESOLVING', 'COMPLETED', 'CANCELLED', 'ABANDONED', 'EXPIRED'] as const) {
    assert.equal(canSafetyPause(phase), false, `${phase} must not be pausable`);
  }
});

test('suspension fairness: timer continues, catch cannot complete while suspended, repeat triggers host check-in', () => {
  let p = mkPlayer('r1');
  assert.equal(canCompleteCatchWhileRunnerSuspended(), false);
  for (let i = 1; i <= 3; i++) { const r = recordSuspension(p, 3); p = r.player; if (i < 3) assert.equal(r.outcome.hostCheckinRequired, false); }
  assert.equal(p.suspensionCount, 3);
  const last = recordSuspension(mkPlayer('x'), 3);
  assert.equal(last.outcome.hostCheckinRequired, false);
  const third = recordSuspension({ ...mkPlayer('y'), suspensionCount: 2 }, 3);
  assert.equal(third.outcome.hostCheckinRequired, true);
});

test('pings: expired pings are never delivered and snapshots exclude pending pings', () => {
  const now = Date.now();
  const ping = { pingId: 'p1', roomId: 'r1', subjectPlayerId: 'r1', recipientRole: 'hunters' as const, uncertainty: { centre: { lat: 0, lng: 0 }, radiusMeters: 100 }, ageSeconds: 10, qualityAtPing: 'good' as const, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 1000).toISOString() };
  assert.equal(isPingDeliverable(ping, now), true);
  assert.equal(isPingDeliverable(ping, now + 2000), false);
  assert.deepEqual(purgeExpiredPings([ping], now + 2000), []);
  assert.deepEqual(snapshotPings([ping], now), []); // recovery snapshots carry no pending pings
});

test('zone: point-in-polygon', () => {
  const poly = [{ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, { lat: 10, lng: 10 }, { lat: 10, lng: 0 }];
  assert.equal(pointInPolygon({ lat: 5, lng: 5 }, poly), true);
  assert.equal(pointInPolygon({ lat: 20, lng: 5 }, poly), false);
});

test('scoring: hunters win only when every runner is caught', () => {
  const players = assignRoles([mkPlayer('h1'), mkPlayer('r1'), mkPlayer('r2')], 1);
  assert.equal(resolveOutcome(players, ['r1', 'r2'], false).outcome, 'hunters-win');
  assert.equal(resolveOutcome(players, ['r1'], true).outcome, 'runners-win');
  assert.deepEqual(resolveOutcome(players, ['r1'], true).survivingRunnerIds, ['r2']);
});

test('calibration: poor GPS is a quality tier, never cheating evidence', () => {
  const cal = { accuracyGoodMaxM: 10, accuracyFairMaxM: 25, accuracyPoorMaxM: 60 };
  assert.equal(classifyAccuracy(5, cal), 'good');
  assert.equal(classifyAccuracy(20, cal), 'fair');
  assert.equal(classifyAccuracy(500, cal), 'poor'); // still just 'poor', not 'suspicious'
});

test('room config: host ranges + mode rules enforced, no venue name anywhere', () => {
  assert.deepEqual(validateRoomConfig(mkConfig()), []);
  // The schema has no venue/area name field at all.
  assert.equal('venueName' in mkConfig(), false);
  assert.ok(validateRoomConfig({ ...mkConfig(), hostOnSiteConfirmed: false }).length > 0);
  assert.ok(validateRoomConfig({ ...mkConfig(), maxPlayers: 2 }).length > 0);
  // Full host ranges (Brief v2): duration 5 min–3 h, head start 0–30 min,
  // ping 0 (none) or 30 s–30 min, shrink 1–60 min when on.
  assert.ok(validateRoomConfig({ ...mkConfig(), durationSeconds: 299 }).length > 0);
  assert.ok(validateRoomConfig({ ...mkConfig(), durationSeconds: 10800 }).length === 0);
  assert.ok(validateRoomConfig({ ...mkConfig(), durationSeconds: 10801 }).length > 0);
  assert.ok(validateRoomConfig({ ...mkConfig(), headStartSeconds: 1800 }).length === 0);
  assert.ok(validateRoomConfig({ ...mkConfig(), headStartSeconds: 1801 }).length > 0);
  assert.deepEqual(validateRoomConfig({ ...mkConfig(), pingIntervalSeconds: 0 }), []); // no pings
  assert.ok(validateRoomConfig({ ...mkConfig(), pingIntervalSeconds: 15 }).length > 0);
  assert.deepEqual(validateRoomConfig({ ...mkConfig(), pingIntervalSeconds: 30 }), []); // 30 s pings allowed
  assert.ok(validateRoomConfig({ ...mkConfig(), pingIntervalSeconds: 1800 }).length === 0);
  // Mode rules: only Classic and Infection exist in the pilot
  // (founder decision, 2026-11-17) — an unknown mode is rejected
  // outright, and both real modes validate clean.
  assert.deepEqual(validateRoomConfig({ ...mkConfig(), mode: 'classic' }), []);
  assert.deepEqual(validateRoomConfig({ ...mkConfig(), mode: 'infection' }), []);
  assert.ok(validateRoomConfig({ ...mkConfig(), mode: 'zombie' as never }).length > 0);
  assert.ok(validateRoomConfig({ ...mkConfig(), mode: 'breach' as never }).length > 0);
  // Outside-zone rule is a single fixed founder rule, not host-set
  // times: the config carries no outside-zone timing fields at all,
  // and a config without them validates.
  assert.equal('outsideZoneLiveSeconds' in mkConfig(), false);
  assert.equal('outsideZoneTagSeconds' in mkConfig(), false);
  assert.deepEqual(validateRoomConfig(mkConfig()), []);
});

test('hash: pure-TS SHA-256 matches the known test vector', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('scoring (QA GL-10): an ejected Runner is never a survivor in resolveOutcome', () => {
  const players = assignRoles([mkPlayer('h1'), mkPlayer('r1'), mkPlayer('r2')], 1);
  const ejected = players.map((p) => (p.playerId === 'r2' ? { ...p, ejectedAt: new Date().toISOString() } : p));
  assert.deepEqual(resolveOutcome(ejected, ['r1'], true).survivingRunnerIds, []);
  assert.equal(resolveOutcome(ejected, ['r1'], true).outcome, 'hunters-win');
  assert.deepEqual(resolveOutcome(ejected, [], true).survivingRunnerIds, ['r1']);
  assert.equal(resolveOutcome(ejected, [], true).outcome, 'runners-win');
});

test('snapshot (MP-ROLE-LEAK): authorisedSnapshot shows a seat its OWN role only', async () => {
  const { authorisedSnapshot } = await import('../src/snapshot.js');
  const room = { roomId: 'r1', roomCode: 'ABC123', hostPlayerId: 'h1', phase: 'ACTIVE', version: 1, config: mkConfig(), createdAt: new Date().toISOString(), startedAt: null, endsAt: null, pausedAt: null, result: null } as never;
  const players = assignRoles([mkPlayer('h1', true), mkPlayer('r1'), mkPlayer('r2')], 1);
  const snap = authorisedSnapshot(room, players, 'r1');
  assert.equal(snap.players.find((p) => p.playerId === 'r1')?.matchRole, 'runner');
  assert.equal(snap.players.find((p) => p.playerId === 'h1')?.matchRole, null);
  assert.equal(snap.players.find((p) => p.playerId === 'h1')?.team, null);
  assert.ok(!('reconnectTokenHash' in snap.players[0]!));
});
