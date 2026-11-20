import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  runnerScore,
  hunterScore,
  isCleanSweep,
  scorePlayer,
  scoreMatch,
} = await import('../src/scoring.ts');

const huntersWin = (overrides = {}) => ({
  outcome: 'hunters-win',
  durationSeconds: 1800,
  caughtRunnerIds: ['r2'],
  survivingRunnerIds: [],
  tags: [],
  ...overrides,
});

test('runnerScore: +1 per whole 3 min free, +10 when never caught', () => {
  const neverCaught = {
    playerId: 'r1',
    matchRole: 'runner',
    freeSeconds: 540,
    caught: false,
    ejected: false,
    tagsMade: 0,
  };
  assert.equal(runnerScore(neverCaught), 13); // 3 blocks + 10
  assert.equal(runnerScore({ ...neverCaught, freeSeconds: 179 }), 10); // 0 blocks + 10
  assert.equal(runnerScore({ ...neverCaught, freeSeconds: 180 }), 11); // 1 block + 10
});

test('runnerScore: a caught runner keeps free-time points but loses the bonus', () => {
  const caught = {
    playerId: 'r2',
    matchRole: 'runner',
    freeSeconds: 600,
    caught: true,
    ejected: false,
    tagsMade: 0,
  };
  assert.equal(runnerScore(caught), 3);
});

test('runnerScore: a born hunter earns no runner points', () => {
  assert.equal(
    runnerScore({
      playerId: 'h1',
      matchRole: 'hunter',
      freeSeconds: 1800,
      caught: false,
      ejected: false,
      tagsMade: 0,
    }),
    0,
  );
});

test('runnerScore: a flipped runner keeps the free-time points earned before the flip', () => {
  assert.equal(
    runnerScore({
      playerId: 'f1',
      matchRole: 'hunter',
      wasRunner: true,
      freeSeconds: 360,
      caught: true,
      ejected: false,
      tagsMade: 0,
    }),
    2,
  );
});

test('hunterScore: +3 per tag, +10 clean sweep only when the hunters won', () => {
  const hunter = {
    playerId: 'h1',
    matchRole: 'hunter',
    freeSeconds: 0,
    caught: false,
    ejected: false,
    tagsMade: 2,
  };
  assert.equal(hunterScore(hunter, false, true), 6);
  assert.equal(hunterScore(hunter, true, true), 16);
  assert.equal(hunterScore(hunter, true, false), 6);
  assert.equal(hunterScore({ ...hunter, matchRole: 'runner' }, true, true), 0);
});

test('isCleanSweep: every runner caught, none ejected, none surviving, hunters won', () => {
  assert.equal(isCleanSweep({ result: huntersWin(), ejectedRunnerIds: [] }), true);
  assert.equal(
    isCleanSweep({ result: huntersWin(), ejectedRunnerIds: ['x'] }),
    false,
  );
  assert.equal(
    isCleanSweep({
      result: huntersWin({ survivingRunnerIds: ['r1'] }),
      ejectedRunnerIds: [],
    }),
    false,
  );
  assert.equal(
    isCleanSweep({
      result: huntersWin({ outcome: 'runners-win' }),
      ejectedRunnerIds: [],
    }),
    false,
  );
  assert.equal(
    isCleanSweep({
      result: huntersWin({ caughtRunnerIds: [] }),
      ejectedRunnerIds: [],
    }),
    false,
  );
});

test('scorePlayer: a flipped runner earns BOTH parts — runner free time + hunter tags', () => {
  const flipped = {
    playerId: 'f1',
    matchRole: 'hunter',
    wasRunner: true,
    freeSeconds: 360,
    caught: true,
    ejected: false,
    tagsMade: 1,
  };
  // 2 runner points (360 s free) + 3 tag points + 10 clean sweep = 15.
  assert.equal(
    scorePlayer(flipped, { result: huntersWin(), cleanSweep: true }),
    15,
  );
});

test('scorePlayer: no result means no points', () => {
  const runner = {
    playerId: 'r1',
    matchRole: 'runner',
    freeSeconds: 1800,
    caught: false,
    ejected: false,
    tagsMade: 0,
  };
  assert.equal(scorePlayer(runner, { result: null, cleanSweep: false }), 0);
});

test('scoreMatch: a completed match scores everyone, with a breakdown', () => {
  const { scores, breakdown } = scoreMatch({
    players: [
      {
        playerId: 'r1',
        matchRole: 'runner',
        freeSeconds: 1800,
        caught: false,
        ejected: false,
        tagsMade: 0,
      },
      {
        playerId: 'r2',
        matchRole: 'runner',
        freeSeconds: 600,
        caught: true,
        ejected: false,
        tagsMade: 0,
      },
      {
        playerId: 'h1',
        matchRole: 'hunter',
        freeSeconds: 0,
        caught: false,
        ejected: false,
        tagsMade: 2,
      },
    ],
    // r1 survived, so this is NOT a clean sweep.
    result: huntersWin({ survivingRunnerIds: ['r1'] }),
    ejectedRunnerIds: [],
  });
  assert.deepEqual(scores, { r1: 20, r2: 3, h1: 6 });
  assert.deepEqual(
    breakdown.find((b) => b.playerId === 'r1'),
    {
      playerId: 'r1',
      points: 20,
      freeBlocks: 10,
      neverCaughtBonus: true,
      tagsMade: 0,
      cleanSweepBonus: false,
    },
  );
  assert.equal(breakdown.find((b) => b.playerId === 'h1').cleanSweepBonus, false);
});

test('scoreMatch: a null result scores 0 for every player', () => {
  const { scores, breakdown } = scoreMatch({
    players: [
      {
        playerId: 'r1',
        matchRole: 'runner',
        freeSeconds: 1800,
        caught: false,
        ejected: false,
        tagsMade: 0,
      },
    ],
    result: null,
    ejectedRunnerIds: [],
  });
  assert.deepEqual(scores, { r1: 0 });
  assert.equal(breakdown[0].points, 0);
});
