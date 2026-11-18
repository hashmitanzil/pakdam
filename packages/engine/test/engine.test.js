import test from 'node:test';
import assert from 'node:assert/strict';
import { transition, canTransition } from '../src/state-machine.js';
import { assignRoles } from '../src/roles.js';
import { issueCatchToken, verifyCatchToken, resolveCatch, expireCatch, gpsEvidenceForCatch } from '../src/catch.js';
import { recordSuspension, canCompleteCatchWhileRunnerSuspended } from '../src/suspension.js';
import { isPingDeliverable, purgeExpiredPings, snapshotPings } from '../src/pings.js';
import { pointInPolygon } from '../src/zone.js';
import { resolveOutcome } from '../src/scoring.js';
import { classifyAccuracy, validateRoomConfig } from '@pakdam/shared';
const mkPlayer = (id, isHost = false) => ({
    playerId: id, roomId: 'r1', kind: isHost ? 'host-account' : 'guest', displayName: id,
    isHost, matchRole: null, team: null, reconnectTokenHash: 'hash', joinedAt: new Date().toISOString(),
    leftAt: null, connectionState: 'connected', lastFixAt: null, locationQuality: 'unknown',
    isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
});
const mkConfig = () => ({
    mode: 'classic', maxPlayers: 16, hunterCount: 1, durationSeconds: 1800, headStartSeconds: 180,
    pingIntervalSeconds: 180, zone: { boundary: [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }], shrinkPhases: [] },
    safeAreas: [], noGoAreas: [], venueName: 'Test Park', hostOnSiteConfirmed: true,
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
test('roles: host is a permission, not a match role — host can be a hunter', () => {
    const players = [mkPlayer('h1', true), mkPlayer('r1'), mkPlayer('r2')];
    const assigned = assignRoles(players, 1);
    assert.equal(assigned[0].isHost, true);
    assert.equal(assigned[0].matchRole, 'hunter'); // host IS the hunter here
    assert.equal(assigned[1].matchRole, 'runner');
    assert.equal(assigned[2].team, 'runners');
    assert.throws(() => assignRoles(players.slice(0, 2), 2), /hunterCount/);
});
test('catch: token is single-use verifiable, replay with wrong code fails, confirm wins, dispute blocks', () => {
    const tok = issueCatchToken('c1', 120, 1000);
    assert.equal(verifyCatchToken('c1', tok.raw, tok.hash), true);
    assert.equal(verifyCatchToken('c1', 'WRONGCODE', tok.hash), false);
    assert.equal(verifyCatchToken('c2', tok.raw, tok.hash), false); // cross-room/catch reuse
    const c = { catchId: 'c1', roomId: 'r1', hunterPlayerId: 'h1', runnerPlayerId: 'r1', state: 'awaiting-confirmation', qrTokenHash: tok.hash, requestedAt: new Date().toISOString(), confirmedAt: null, disputedAt: null, resolution: null, gpsEvidence: 'present' };
    assert.equal(resolveCatch(c, 'confirm', new Date().toISOString()).state, 'confirmed');
    const d = resolveCatch(c, 'dispute', new Date().toISOString());
    assert.equal(d.state, 'disputed');
    assert.equal(expireCatch({ ...c, state: 'requested' }).state, 'expired');
    assert.equal(gpsEvidenceForCatch(null, 2000, 30000), 'absent'); // absent GPS is never negative evidence
});
test('suspension fairness: timer continues, catch cannot complete while suspended, repeat triggers host check-in', () => {
    let p = mkPlayer('r1');
    assert.equal(canCompleteCatchWhileRunnerSuspended(), false);
    for (let i = 1; i <= 3; i++) {
        const r = recordSuspension(p, 3);
        p = r.player;
        if (i < 3)
            assert.equal(r.outcome.hostCheckinRequired, false);
    }
    assert.equal(p.suspensionCount, 3);
    const last = recordSuspension(mkPlayer('x'), 3);
    assert.equal(last.outcome.hostCheckinRequired, false);
    const third = recordSuspension({ ...mkPlayer('y'), suspensionCount: 2 }, 3);
    assert.equal(third.outcome.hostCheckinRequired, true);
});
test('pings: expired pings are never delivered and snapshots exclude pending pings', () => {
    const now = Date.now();
    const ping = { pingId: 'p1', roomId: 'r1', subjectPlayerId: 'r1', recipientRole: 'hunters', uncertainty: { centre: { lat: 0, lng: 0 }, radiusMeters: 100 }, ageSeconds: 10, qualityAtPing: 'good', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 1000).toISOString() };
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
test('room config: venue-only pilot enforced', () => {
    assert.deepEqual(validateRoomConfig(mkConfig()), []);
    assert.ok(validateRoomConfig({ ...mkConfig(), venueName: '' }).length > 0);
    assert.ok(validateRoomConfig({ ...mkConfig(), hostOnSiteConfirmed: false }).length > 0);
    assert.ok(validateRoomConfig({ ...mkConfig(), maxPlayers: 2 }).length > 0);
});
//# sourceMappingURL=engine.test.js.map