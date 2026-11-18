import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Demo-store role stability (final verification, 2026-11-17): roles are
// assigned ONCE at HEAD_START. setPhase used to re-assign (re-draw) them
// on HEAD_START -> ACTIVE too, so the Hunter revealed during the head
// start could flip when play began — 4 of 5 probe trials changed
// Hunter. This pins the fix; run via `npm run test:web`
// (scripts/test-web-lib.sh compiles this suite to scratch).
// ---------------------------------------------------------------------------

const store = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
g['window'] = {};
g['localStorage'] = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const { createRoom, joinRoom, toggleReady, setPhase, getRoom } = await import('../demo-store.js');

const config = {
  mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
  durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 180,
  zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
  catchConfirmationRequired: true, playZoneEnabled: true,
  balanceHunters: true, randomDraw: true,
  zone: {
    boundary: [
      { lat: 23.35, lng: 85.32 }, { lat: 23.35, lng: 85.325 },
      { lat: 23.355, lng: 85.325 }, { lat: 23.355, lng: 85.32 },
    ], shrinkPhases: [],
  },
  safeAreas: [], noGoAreas: [], selectedHunterIds: [], hostOnSiteConfirmed: true,
} as never;

function startRoom(): string {
  store.clear();
  const { room } = createRoom('Host', config);
  for (const name of ['A', 'B', 'C']) {
    const p = joinRoom(room.roomId, name);
    toggleReady(room.roomId, p.playerId);
  }
  setPhase(room.roomId, 'READY_CHECK');
  setPhase(room.roomId, 'COUNTDOWN');
  return room.roomId;
}

test('demo roles: the Hunter drawn at HEAD_START is still the Hunter at ACTIVE (5 trials)', () => {
  for (let i = 0; i < 5; i++) {
    const roomId = startRoom();
    const atHeadStart = getRoom(roomId);
    setPhase(roomId, 'HEAD_START');
    const hunterHead = getRoom(roomId)!.players.filter((p) => p.matchRole === 'hunter').map((p) => p.playerId);
    assert.equal(hunterHead.length, 1);
    setPhase(roomId, 'ACTIVE');
    const hunterActive = getRoom(roomId)!.players.filter((p) => p.matchRole === 'hunter').map((p) => p.playerId);
    assert.deepEqual(hunterActive, hunterHead, `trial ${i + 1}: Hunter must not change between HEAD_START and ACTIVE`);
    assert.equal(atHeadStart!.room.phase, 'COUNTDOWN');
  }
});

test('demo roles: a safety pause + resume does not re-draw roles either', () => {
  const roomId = startRoom();
  setPhase(roomId, 'HEAD_START');
  const hunterHead = getRoom(roomId)!.players.filter((p) => p.matchRole === 'hunter').map((p) => p.playerId);
  setPhase(roomId, 'ACTIVE');
  setPhase(roomId, 'SAFETY_PAUSED');
  setPhase(roomId, 'ACTIVE');
  const hunterAfter = getRoom(roomId)!.players.filter((p) => p.matchRole === 'hunter').map((p) => p.playerId);
  assert.deepEqual(hunterAfter, hunterHead, 'Hunter must survive pause + resume unchanged');
});
