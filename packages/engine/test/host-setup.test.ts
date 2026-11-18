import test from 'node:test';
import assert from 'node:assert/strict';
import { assignRoles, balancedHunterCount } from '../src/roles.js';
import { SHRINK_RADIUS_FACTOR, shrunkRadiusMeters } from '../src/zone.js';
import type { Player } from '@pakdam/shared';

const mkPlayer = (id: string): Player => ({
  playerId: id, roomId: 'r1', kind: 'guest', displayName: id,
  isHost: false, matchRole: null, team: null, reconnectTokenHash: 'hash', joinedAt: new Date().toISOString(),
  leftAt: null, connectionState: 'connected', lastFixAt: null, locationQuality: 'unknown',
  isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0, ejectedAt: null,
});

test('host setup: balanced Hunter table is the provisional frame table (calibration OPEN)', () => {
  assert.equal(balancedHunterCount(3), 1);
  assert.equal(balancedHunterCount(4), 1);
  assert.equal(balancedHunterCount(5), 2);
  assert.equal(balancedHunterCount(6), 2); // "2 for 6 players"
  assert.equal(balancedHunterCount(8), 2);
  assert.equal(balancedHunterCount(9), 3);
  assert.equal(balancedHunterCount(16), 3); // "3 for 16"
});

test('host setup: each shrink keeps 75% of the radius (loses a quarter)', () => {
  assert.equal(SHRINK_RADIUS_FACTOR, 0.75);
  assert.equal(shrunkRadiusMeters(500, 0), 500);
  assert.equal(shrunkRadiusMeters(500, 1), 375);
  assert.equal(shrunkRadiusMeters(500, 2), 281.25);
  assert.equal(shrunkRadiusMeters(1000, 3), 421.875);
});

test('host setup: random draw assigns exactly hunterCount Hunters, every player gets a role', () => {
  const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(mkPlayer);
  for (let i = 0; i < 10; i++) {
    const assigned = assignRoles(players, 2, { teamAssignment: 'random', shuffle: true });
    assert.equal(assigned.filter((p) => p.matchRole === 'hunter').length, 2);
    assert.equal(assigned.filter((p) => p.matchRole === 'runner').length, 4);
    assert.ok(assigned.every((p) => p.team !== null));
  }
});

test('host setup: legacy join-order draw is unchanged when shuffle is off', () => {
  const players = ['p1', 'p2', 'p3', 'p4'].map(mkPlayer);
  const assigned = assignRoles(players, 1, { teamAssignment: 'random' });
  assert.equal(assigned.find((p) => p.playerId === 'p1')!.matchRole, 'hunter');
  assert.equal(assigned.filter((p) => p.matchRole === 'runner').length, 3);
});

test('host setup: selected assignment still picks exactly the host-chosen Hunters', () => {
  const players = ['p1', 'p2', 'p3', 'p4'].map(mkPlayer);
  const assigned = assignRoles(players, 2, { teamAssignment: 'selected', selectedHunterIds: ['p3', 'p4'] });
  assert.deepEqual(assigned.filter((p) => p.matchRole === 'hunter').map((p) => p.playerId).sort(), ['p3', 'p4']);
  assert.throws(() => assignRoles(players, 2, { teamAssignment: 'selected', selectedHunterIds: ['p3'] }), /exactly hunterCount/);
});
