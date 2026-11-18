import test from 'node:test';
import assert from 'node:assert/strict';
import { assignRoles } from '../src/roles.js';
import { applyConfirmedTag, describeMode, modeTurnsRunner, resolveModeOutcome } from '../src/modes.js';
import { isOutsideZoneEjectionDue, outsideZoneReturnRemainingSeconds, shrinkTimesSeconds, zoneDiameterMeters } from '../src/zone.js';
import { validateHousePreset } from '@pakdam/shared';
import type { HouseRulePreset, Player } from '@pakdam/shared';

const mkPlayer = (id: string): Player => ({
  playerId: id, roomId: 'r1', kind: 'guest', displayName: id,
  isHost: false, matchRole: null, team: null, reconnectTokenHash: 'hash', joinedAt: new Date().toISOString(),
  leftAt: null, connectionState: 'connected', lastFixAt: null, locationQuality: 'unknown',
  isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0, ejectedAt: null,
});
const mkPreset = (): HouseRulePreset => ({
  presetId: 'p1', name: 'My house rules', createdAt: new Date().toISOString(),
  rules: {
    mode: 'classic', teamAssignment: 'random', maxPlayers: 8, hunterCount: 2,
    durationSeconds: 1800, headStartSeconds: 300, pingIntervalSeconds: 180,
    zoneShrinkEnabled: true, zoneShrinkIntervalSeconds: 600,
    catchConfirmationRequired: true,
  },
});

test('modes: every mode has its own rules, described in Pakdam wording', () => {
  // Only Classic and Infection exist in the pilot (founder decision,
  // 2026-11-17): Breach and Zombie are later, not now.
  for (const mode of ['classic', 'infection'] as const) {
    const info = describeMode(mode);
    assert.ok(info.label.length > 0 && info.catchRule.length > 0 && info.winRule.length > 0);
  }
  assert.equal(modeTurnsRunner('classic'), false);
  assert.equal(modeTurnsRunner('infection'), true);
});

test('modes: classic tag puts the Runner out; infection tag turns them', () => {
  const players = assignRoles([mkPlayer('h1'), mkPlayer('r1'), mkPlayer('r2')], 1);
  const classic = applyConfirmedTag(players, 'r1', 'classic');
  assert.equal(classic.caughtRunnerId, 'r1');
  assert.equal(classic.turnedHunterId, null);
  assert.equal(classic.players.find((p) => p.playerId === 'r1')!.matchRole, 'runner'); // still a Runner, recorded as caught
  const infected = applyConfirmedTag(players, 'r1', 'infection');
  assert.equal(infected.turnedHunterId, 'r1');
  assert.equal(infected.caughtRunnerId, null);
  assert.equal(infected.players.find((p) => p.playerId === 'r1')!.matchRole, 'hunter');
  assert.equal(infected.players.find((p) => p.playerId === 'r1')!.team, 'hunters');
  const turned = applyConfirmedTag(players, 'r2', 'infection');
  assert.equal(turned.players.find((p) => p.playerId === 'r2')!.matchRole, 'hunter');
  assert.throws(() => applyConfirmedTag(players, 'h1', 'classic'), /only a Runner/);
});

test('modes: outcomes — classic needs every Runner caught, infection needs no Runner left', () => {
  const players = assignRoles([mkPlayer('h1'), mkPlayer('r1'), mkPlayer('r2')], 1);
  assert.equal(resolveModeOutcome(players, ['r1', 'r2'], false, 'classic').outcome, 'hunters-win');
  assert.equal(resolveModeOutcome(players, ['r1'], true, 'classic').outcome, 'runners-win');
  // Infection: after r1 turns, one Runner is still left, so Runners win on time.
  const turned = applyConfirmedTag(players, 'r1', 'infection').players;
  assert.equal(resolveModeOutcome(turned, ['r1'], true, 'infection').outcome, 'runners-win');
  const allTurned = applyConfirmedTag(turned, 'r2', 'infection').players;
  assert.equal(resolveModeOutcome(allTurned, ['r1', 'r2'], false, 'infection').outcome, 'hunters-win');
  assert.deepEqual(resolveModeOutcome(allTurned, ['r1', 'r2'], false, 'infection').survivingRunnerIds, []);
});

test('roles: selected assignment picks exactly the host-chosen Hunters', () => {
  const players = [mkPlayer('a'), mkPlayer('b'), mkPlayer('c'), mkPlayer('d')];
  const assigned = assignRoles(players, 2, { teamAssignment: 'selected', selectedHunterIds: ['c', 'a'] });
  assert.deepEqual(assigned.filter((p) => p.matchRole === 'hunter').map((p) => p.playerId).sort(), ['a', 'c']);
  assert.deepEqual(assigned.filter((p) => p.matchRole === 'runner').map((p) => p.playerId).sort(), ['b', 'd']);
  assert.throws(() => assignRoles(players, 2, { teamAssignment: 'selected', selectedHunterIds: ['a'] }), /exactly hunterCount/);
  assert.throws(() => assignRoles(players, 2, { teamAssignment: 'selected', selectedHunterIds: ['a', 'zz'] }), /joined players/);
  assert.throws(() => assignRoles(players, 2, { teamAssignment: 'selected', selectedHunterIds: ['a', 'a'] }), /repeat/);
  // Random still works as before: first players by join order.
  const random = assignRoles(players, 1, { teamAssignment: 'random' });
  assert.equal(random[0]!.matchRole, 'hunter');
  assert.equal(random[1]!.matchRole, 'runner');
});

test('zone: outside-zone rule is a fixed 30-second return countdown, then ejection', () => {
  // Founder rule (2026-11-17): 30 s outside → ejected. No host-set
  // times, no "tagged" outcome — the countdown is the whole rule.
  assert.equal(outsideZoneReturnRemainingSeconds(0), 30);
  assert.equal(outsideZoneReturnRemainingSeconds(10), 20);
  assert.equal(outsideZoneReturnRemainingSeconds(29), 1);
  assert.equal(outsideZoneReturnRemainingSeconds(30), 0);
  assert.equal(outsideZoneReturnRemainingSeconds(90), 0);
  assert.equal(isOutsideZoneEjectionDue(29), false);
  assert.equal(isOutsideZoneEjectionDue(30), true);
  assert.equal(isOutsideZoneEjectionDue(31), true);
  assert.deepEqual(shrinkTimesSeconds(1800, 600, true), [600, 1200]);
  assert.deepEqual(shrinkTimesSeconds(1800, 600, false), []);
  assert.deepEqual(shrinkTimesSeconds(600, 600, true), []);
  // An 8-point circle polygon ~550 m across measures ~550 m.
  const boundary = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * 2 * Math.PI;
    return { lat: 23.3642 + (275 * Math.cos(a)) / 111320, lng: 85.331 + (275 * Math.sin(a)) / (111320 * Math.cos((23.3642 * Math.PI) / 180)) };
  });
  const d = zoneDiameterMeters(boundary);
  assert.ok(d > 500 && d < 600, `diameter ${d} should be about 550 m`);
});

test('modes: an ejected Runner is out, never a survivor — in either mode', () => {
  // Classic: two Runners, one ejected → the ejected one is not a
  // survivor, and Hunters win only when no Runner is left free.
  const classic = [
    { ...mkPlayer('h1'), matchRole: 'hunter' as const, team: 'hunters' as const },
    { ...mkPlayer('r1'), matchRole: 'runner' as const, team: 'runners' as const },
    { ...mkPlayer('r2'), matchRole: 'runner' as const, team: 'runners' as const, ejectedAt: new Date().toISOString() },
  ];
  const oneLeft = resolveModeOutcome(classic, [], false, 'classic');
  assert.deepEqual(oneLeft.survivingRunnerIds, ['r1']);
  assert.equal(oneLeft.outcome, 'runners-win');
  const noneLeft = resolveModeOutcome(
    classic.map((p) => (p.playerId === 'r1' ? { ...p, ejectedAt: new Date().toISOString() } : p)),
    [], false, 'classic',
  );
  assert.deepEqual(noneLeft.survivingRunnerIds, []);
  assert.equal(noneLeft.outcome, 'hunters-win');
  // Infection: the same — an ejected Runner is not left to hunt.
  const infection = resolveModeOutcome(classic, [], false, 'infection');
  assert.deepEqual(infection.survivingRunnerIds, ['r1']);
});

test('house presets: a saved preset validates with the same rules as a room', () => {
  assert.deepEqual(validateHousePreset(mkPreset()), []);
  assert.ok(validateHousePreset({ ...mkPreset(), name: '  ' }).length > 0);
  assert.ok(validateHousePreset({ ...mkPreset(), rules: { ...mkPreset().rules, durationSeconds: 60 } }).length > 0);
  // A mode outside Classic/Infection is rejected outright.
  assert.ok(validateHousePreset({ ...mkPreset(), rules: { ...mkPreset().rules, mode: 'zombie' as never } }).length > 0);
  assert.deepEqual(validateHousePreset({ ...mkPreset(), rules: { ...mkPreset().rules, mode: 'infection', pingIntervalSeconds: 0 } }), []);
});
