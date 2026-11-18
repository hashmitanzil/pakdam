import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMatchPoints, isCleanSweep } from '../src/scoring.js';
import type { Player } from '@pakdam/shared';

const mkPlayer = (id: string, role: 'hunter' | 'runner', ejected = false): Player => ({
  playerId: id, roomId: 'r1', kind: 'guest', displayName: id,
  isHost: false, matchRole: role, team: role === 'hunter' ? 'hunters' : 'runners',
  reconnectTokenHash: 'hash', joinedAt: new Date().toISOString(),
  leftAt: null, connectionState: 'connected', lastFixAt: null, locationQuality: 'unknown',
  isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
  ejectedAt: ejected ? new Date().toISOString() : null,
});

test('points: +1 per 3 min free, +10 never caught, +3 per tag, +10 clean sweep', () => {
  // Runner free the whole 30-min match: 10 free points + 10 never caught.
  // Hunter with 2 tags in a clean sweep: 6 + 10.
  const points = computeMatchPoints([
    { playerId: 'r1', matchRole: 'runner', freeSeconds: 1800, tags: 0, caught: false, ejected: false },
    { playerId: 'r2', matchRole: 'runner', freeSeconds: 600, tags: 0, caught: true, ejected: false },
    { playerId: 'h1', matchRole: 'hunter', freeSeconds: 0, tags: 2, caught: false, ejected: false },
  ], true);
  const byId = new Map(points.map((p) => [p.playerId, p]));
  assert.equal(byId.get('r1')!.points, 20);
  assert.deepEqual([byId.get('r1')!.freeMinutesPoints, byId.get('r1')!.neverCaughtBonus], [10, 10]);
  // Caught after 10 min free: 3 free points, no never-caught bonus.
  assert.equal(byId.get('r2')!.points, 3);
  assert.equal(byId.get('r2')!.neverCaughtBonus, 0);
  assert.equal(byId.get('h1')!.points, 16);
  assert.deepEqual([byId.get('h1')!.tagPoints, byId.get('h1')!.cleanSweepBonus], [6, 10]);
});

test('points: partial 3-minute blocks earn nothing; no sweep, no sweep bonus', () => {
  const points = computeMatchPoints([
    { playerId: 'r1', matchRole: 'runner', freeSeconds: 179, tags: 0, caught: false, ejected: false },
    { playerId: 'h1', matchRole: 'hunter', freeSeconds: 0, tags: 1, caught: false, ejected: false },
  ], false);
  const byId = new Map(points.map((p) => [p.playerId, p]));
  assert.equal(byId.get('r1')!.freeMinutesPoints, 0);
  assert.equal(byId.get('r1')!.points, 10); // never-caught bonus only
  assert.equal(byId.get('h1')!.points, 3);
  assert.equal(byId.get('h1')!.cleanSweepBonus, 0);
});

test('points: an ejected Runner gets free-time points but never the never-caught bonus', () => {
  const points = computeMatchPoints([
    { playerId: 'r1', matchRole: 'runner', freeSeconds: 540, tags: 0, caught: false, ejected: true },
  ], false);
  assert.equal(points[0]!.points, 3);
  assert.equal(points[0]!.neverCaughtBonus, 0);
});

test('points: a turned Infection Runner keeps free-time points, gets no never-caught bonus', () => {
  // Turned after 12 min free, then made 1 tag as a Hunter.
  const points = computeMatchPoints([
    { playerId: 'r1', matchRole: 'hunter', freeSeconds: 720, tags: 1, caught: true, ejected: false },
  ], false);
  assert.equal(points[0]!.freeMinutesPoints, 4);
  assert.equal(points[0]!.tagPoints, 3);
  assert.equal(points[0]!.neverCaughtBonus, 0);
  assert.equal(points[0]!.points, 7);
});

test('clean sweep: every Runner caught, no survivors, no ejected Runners', () => {
  const players = [mkPlayer('h1', 'hunter'), mkPlayer('r1', 'runner'), mkPlayer('r2', 'runner')];
  assert.equal(isCleanSweep(players, ['r1', 'r2']), true);
  assert.equal(isCleanSweep(players, ['r1']), false); // r2 still free
  assert.equal(isCleanSweep(players, []), false);
  // An ejected Runner breaks the sweep — ejected is out, not caught.
  const withEjected = [mkPlayer('h1', 'hunter'), mkPlayer('r1', 'runner'), mkPlayer('r2', 'runner', true)];
  assert.equal(isCleanSweep(withEjected, ['r1']), false);
  assert.equal(isCleanSweep(withEjected, ['r1', 'r2']), false);
  // Infection: turned Runners count as caught.
  const turned = [mkPlayer('h1', 'hunter'), mkPlayer('r1', 'hunter'), mkPlayer('r2', 'hunter')];
  assert.equal(isCleanSweep(turned, ['r1', 'r2']), true);
  assert.equal(isCleanSweep([], []), false);
});
