import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Demo-store server parity (2026-11-18, Worker 2): the demo store must
// behave like the DO (workers/src/room-do.ts) — roles once, clock from
// HEAD_START, pause freezes + resume returns to the paused-from phase,
// catches authenticated + deduped + QR-expiry enforced. Run via
// `npm run test:web` (scripts/test-web-lib.sh).
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

const {
  createRoom, joinRoom, toggleReady, setPhase, getRoom, tickDemoRoom,
  requestCatch, confirmCatch, disputeCatch, verifyCatchScan, getCatchRaw,
  expireOldCatches,
} = await import('../demo-store.js');

const TTL_SECONDS = 120; // CALIBRATION_OPEN.catchTokenTtlSeconds

function makeConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
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
    ...overrides,
  } as never;
}

const T0 = Date.parse('2026-11-18T00:00:00.000Z');

function startRoom(config: unknown, t0: number = T0): { roomId: string; hostId: string } {
  store.clear();
  const { room } = createRoom('Host', config as never);
  for (const name of ['A', 'B', 'C']) {
    const p = joinRoom(room.roomId, name);
    toggleReady(room.roomId, p.playerId);
  }
  setPhase(room.roomId, 'READY_CHECK', t0);
  setPhase(room.roomId, 'COUNTDOWN', t0);
  return { roomId: room.roomId, hostId: room.hostPlayerId };
}

function toHeadStart(roomId: string, t0: number = T0): void {
  setPhase(roomId, 'HEAD_START', t0);
}

function toActive(roomId: string, nowMs: number): void {
  setPhase(roomId, 'ACTIVE', nowMs);
}

function roles(roomId: string, nowMs: number): { hunters: string[]; runners: string[] } {
  const dr = getRoom(roomId, nowMs)!;
  return {
    hunters: dr.players.filter((p) => p.matchRole === 'hunter').map((p) => p.playerId),
    runners: dr.players.filter((p) => p.matchRole === 'runner').map((p) => p.playerId),
  };
}

// --- (b) clock: starts at HEAD_START, never reset by the ACTIVE flip ---

test('demo clock: startedAt/endsAt are set at HEAD_START and the flip to ACTIVE does not reset them', () => {
  const { roomId } = startRoom(makeConfig());
  toHeadStart(roomId);
  const atHead = getRoom(roomId, T0)!;
  assert.equal(atHead.room.startedAt, new Date(T0).toISOString());
  assert.equal(atHead.room.endsAt, new Date(T0 + 600_000).toISOString());
  assert.equal(atHead.headStartStartedAt, new Date(T0).toISOString());
  toActive(roomId, T0 + 60_000);
  const atActive = getRoom(roomId, T0 + 60_000)!;
  assert.equal(atActive.room.phase, 'ACTIVE');
  assert.equal(atActive.room.startedAt, new Date(T0).toISOString(), 'ACTIVE entry must not restart the clock');
  assert.equal(atActive.room.endsAt, new Date(T0 + 600_000).toISOString(), 'ACTIVE entry must not extend the match');
});

test('demo clock: tick flips HEAD_START→ACTIVE at the head start end and completes the match at endsAt (Runners win)', () => {
  const { roomId } = startRoom(makeConfig());
  toHeadStart(roomId);
  assert.equal(tickDemoRoom(roomId, T0 + 59_000)!.room.phase, 'HEAD_START');
  assert.equal(tickDemoRoom(roomId, T0 + 60_000)!.room.phase, 'ACTIVE');
  assert.equal(tickDemoRoom(roomId, T0 + 599_999)!.room.phase, 'ACTIVE');
  const done = tickDemoRoom(roomId, T0 + 600_000)!;
  assert.equal(done.room.phase, 'COMPLETED');
  assert.equal(done.room.result?.outcome, 'runners-win');
  assert.equal(done.room.result?.durationSeconds, 600);
  assert.equal(done.room.result?.survivingRunnerIds.length, 3);
});

// --- (b) pause: freezes the clock, resume returns to the paused-from phase ---

test('demo pause: pausing in HEAD_START freezes the displayed clock and resume returns to HEAD_START with the remainder kept', () => {
  const { roomId } = startRoom(makeConfig());
  toHeadStart(roomId);
  const hunterBefore = roles(roomId, T0).hunters;
  setPhase(roomId, 'SAFETY_PAUSED', T0 + 10_000);
  // 30 s into the pause the displayed deadlines have not moved in
  // remaining-time terms: endsAt projects forward by the pause so far.
  const projected = getRoom(roomId, T0 + 40_000)!;
  assert.equal(projected.room.phase, 'SAFETY_PAUSED');
  assert.equal(projected.room.endsAt, new Date(T0 + 630_000).toISOString());
  assert.equal(projected.headStartStartedAt, new Date(T0 + 30_000).toISOString());
  // The stored values are untouched until resume.
  const stored = tickDemoRoom(roomId, T0 + 40_000)!;
  assert.equal(stored.room.endsAt, new Date(T0 + 600_000).toISOString());
  assert.equal(stored.room.pausedAt, new Date(T0 + 10_000).toISOString());
  // Resume (the play page asks for ACTIVE) returns to HEAD_START —
  // the head start is NOT skipped — with the clock shifted by the pause.
  const resumed = setPhase(roomId, 'ACTIVE', T0 + 40_000);
  assert.equal(resumed.room.phase, 'HEAD_START');
  assert.equal(resumed.room.endsAt, new Date(T0 + 630_000).toISOString());
  assert.equal(resumed.headStartStartedAt, new Date(T0 + 30_000).toISOString());
  assert.equal(resumed.room.pausedAt, null);
  assert.deepEqual(roles(roomId, T0 + 40_000).hunters, hunterBefore, 'resume must not re-draw roles');
  // The head start now ends 30 s later than it would have: still
  // HEAD_START at T0+89s, ACTIVE at T0+90s.
  assert.equal(tickDemoRoom(roomId, T0 + 89_000)!.room.phase, 'HEAD_START');
  assert.equal(tickDemoRoom(roomId, T0 + 90_000)!.room.phase, 'ACTIVE');
});

test('demo pause: pausing in ACTIVE resumes to ACTIVE with endsAt shifted by the pause, not reset', () => {
  const { roomId } = startRoom(makeConfig());
  toHeadStart(roomId);
  toActive(roomId, T0 + 60_000);
  setPhase(roomId, 'SAFETY_PAUSED', T0 + 100_000);
  const projected = getRoom(roomId, T0 + 130_000)!;
  assert.equal(projected.room.endsAt, new Date(T0 + 630_000).toISOString(), 'frozen: 500 s left at pause, 500 s left 30 s later');
  const resumed = setPhase(roomId, 'ACTIVE', T0 + 160_000);
  assert.equal(resumed.room.phase, 'ACTIVE');
  assert.equal(resumed.room.endsAt, new Date(T0 + 660_000).toISOString(), 'resume shifts endsAt by the 60 s pause, never a fresh duration');
  assert.equal(resumed.room.startedAt, new Date(T0 + 60_000).toISOString(), 'resume shifts startedAt with the clock, like the server — elapsed-time maths stays frozen');
  assert.equal(tickDemoRoom(roomId, T0 + 659_999)!.room.phase, 'ACTIVE');
  assert.equal(tickDemoRoom(roomId, T0 + 660_000)!.room.phase, 'COMPLETED');
});

test('demo pause: a paused room never completes on the tick', () => {
  const { roomId } = startRoom(makeConfig({ durationSeconds: 300 }));
  toHeadStart(roomId);
  setPhase(roomId, 'SAFETY_PAUSED', T0 + 10_000);
  assert.equal(tickDemoRoom(roomId, T0 + 500_000)!.room.phase, 'SAFETY_PAUSED');
});

// --- (c) catches: authenticated, deduped, expiry enforced ---

function activeRoomWithCatch(): { roomId: string; hostId: string; hunterId: string; runnerId: string; secondHunterId?: string } {
  const { roomId, hostId } = startRoom(makeConfig({ balanceHunters: false, hunterCount: 2 }));
  toHeadStart(roomId);
  toActive(roomId, T0 + 60_000);
  const r = roles(roomId, T0 + 60_000);
  assert.equal(r.hunters.length, 2);
  return { roomId, hostId, hunterId: r.hunters[0]!, runnerId: r.runners[0]!, secondHunterId: r.hunters[1] };
}

test('demo catch: only a Hunter may request, only while ACTIVE, one pending claim per Runner', () => {
  const { roomId, hunterId, runnerId, secondHunterId } = activeRoomWithCatch();
  // A Runner may not claim.
  assert.throws(() => requestCatch(roomId, runnerId, runnerId, { nowMs: T0 + 70_000 }), /FORBIDDEN/);
  const first = requestCatch(roomId, hunterId, runnerId, { nowMs: T0 + 70_000 });
  // Same Hunter re-requesting (double-tap / retry) returns the open
  // claim — no second claim, no second token.
  const retry = requestCatch(roomId, hunterId, runnerId, { nowMs: T0 + 71_000 });
  assert.equal(retry.catchId, first.catchId);
  assert.equal(getRoom(roomId, T0 + 71_000)!.catches.length, 1);
  // A different Hunter gets CONFLICT, like the server (GL-05).
  assert.throws(() => requestCatch(roomId, secondHunterId!, runnerId, { nowMs: T0 + 72_000 }), /CONFLICT/);
  // Same idempotency key returns the original claim.
  const keyed = requestCatch(roomId, hunterId, runnerId, { idempotencyKey: 'k1', nowMs: T0 + 73_000 });
  assert.equal(keyed.catchId, first.catchId);
  assert.equal(getRoom(roomId, T0 + 73_000)!.catches.length, 1);
});

test('demo catch: catchConfirmationRequired=false does NOT count the tag at once — Runner confirmation is always required', () => {
  // The auto-confirm branch was removed (simplification round,
  // 2026-11-18): even a stored config with the flag off must leave
  // the catch pending until the Runner confirms it.
  const { roomId } = startRoom(makeConfig({ balanceHunters: false, hunterCount: 2, catchConfirmationRequired: false }));
  toHeadStart(roomId);
  toActive(roomId, T0 + 60_000);
  const r = roles(roomId, T0 + 60_000);
  const c = requestCatch(roomId, r.hunters[0]!, r.runners[0]!, { nowMs: T0 + 70_000 });
  assert.equal(c.state, 'awaiting-confirmation');
  assert.equal(getRoom(roomId, T0 + 70_000)!.room.phase, 'ACTIVE');
  assert.equal(getRoom(roomId, T0 + 70_000)!.players.find((p) => p.playerId === r.runners[0]!)!.matchRole, 'runner');
  // The Runner can still confirm it manually — the claim is live.
  confirmCatch(roomId, c.catchId, 'manual-confirm', r.runners[0]!, T0 + 71_000);
  assert.equal(getRoom(roomId, T0 + 71_000)!.catches[0]!.state, 'confirmed');
});

test('demo catch: no request while HEAD_START, no second claim on an already-caught Runner', () => {
  const { roomId } = startRoom(makeConfig());
  toHeadStart(roomId);
  const r = roles(roomId, T0);
  assert.throws(() => requestCatch(roomId, r.hunters[0]!, r.runners[0]!, { nowMs: T0 + 10_000 }), /not possible while the match is HEAD_START/);
  toActive(roomId, T0 + 60_000);
  const c = requestCatch(roomId, r.hunters[0]!, r.runners[0]!, { nowMs: T0 + 70_000 });
  confirmCatch(roomId, c.catchId, 'manual-confirm', r.runners[0]!, T0 + 71_000);
  assert.throws(() => requestCatch(roomId, r.hunters[0]!, r.runners[0]!, { nowMs: T0 + 72_000 }), /already caught/);
});

test('demo catch: QR-scan confirm needs a verified scan by the claiming Hunter; manual confirm is Runner-only', () => {
  const { roomId, hunterId, runnerId } = activeRoomWithCatch();
  const c = requestCatch(roomId, hunterId, runnerId, { nowMs: T0 + 70_000 });
  const raw = getCatchRaw(c.catchId)!;
  // No actor at all is unauthenticated.
  assert.throws(() => confirmCatch(roomId, c.catchId, 'qr-scan', undefined, T0 + 71_000), /FORBIDDEN/);
  // A scan-less QR confirm is rejected even by the right Hunter.
  assert.throws(() => confirmCatch(roomId, c.catchId, 'qr-scan', hunterId, T0 + 71_000), /no verified QR scan/);
  // Wrong token fails verification; right token verifies.
  assert.equal(verifyCatchScan(roomId, c.catchId, '000000000000', T0 + 71_000), false);
  assert.equal(verifyCatchScan(roomId, c.catchId, raw, T0 + 71_000), true);
  // The Runner may not complete it by QR scan, and the Hunter may
  // not complete it manually.
  assert.throws(() => confirmCatch(roomId, c.catchId, 'qr-scan', runnerId, T0 + 72_000), /only the claiming Hunter/);
  assert.throws(() => confirmCatch(roomId, c.catchId, 'manual-confirm', hunterId, T0 + 72_000), /only the named Runner/);
  // The claiming Hunter confirms after the verified scan; a second
  // confirm is CONFLICT, never a double-apply.
  confirmCatch(roomId, c.catchId, 'qr-scan', hunterId, T0 + 73_000);
  assert.equal(getRoom(roomId, T0 + 73_000)!.catches[0]!.state, 'confirmed');
  assert.throws(() => confirmCatch(roomId, c.catchId, 'qr-scan', hunterId, T0 + 74_000), /already confirmed/);
});

test('demo catch: an expired QR never verifies and never confirms', () => {
  const { roomId, hunterId, runnerId } = activeRoomWithCatch();
  const c = requestCatch(roomId, hunterId, runnerId, { nowMs: T0 + 70_000 });
  const raw = getCatchRaw(c.catchId)!;
  assert.equal(verifyCatchScan(roomId, c.catchId, raw, T0 + 70_000 + TTL_SECONDS * 1000), true, 'still valid at exactly the TTL');
  const c2 = requestCatch(roomId, hunterId, runnerId, { nowMs: T0 + 70_000 });
  assert.equal(c2.catchId, c.catchId, 'same pending claim');
  assert.equal(verifyCatchScan(roomId, c.catchId, raw, T0 + 70_000 + TTL_SECONDS * 1000 + 1), false, 'one millisecond past the TTL the QR is dead');
  assert.equal(getRoom(roomId, T0 + 70_000 + TTL_SECONDS * 1000 + 1)!.catches[0]!.state, 'expired');
  assert.throws(() => confirmCatch(roomId, c.catchId, 'manual-confirm', runnerId, T0 + 70_000 + TTL_SECONDS * 1000 + 2), /expired/);
  // Expiry is also enforced by the sweep, and a fresh claim can open after it.
  const fresh = requestCatch(roomId, hunterId, runnerId, { nowMs: T0 + 200_000 });
  assert.notEqual(fresh.catchId, c.catchId);
  expireOldCatches(roomId, T0 + 200_000 + TTL_SECONDS * 1000 + 1);
  assert.equal(getRoom(roomId, T0 + 200_000 + TTL_SECONDS * 1000 + 1)!.catches.find((x) => x.catchId === fresh.catchId)!.state, 'expired');
});

test('demo catch: dispute is Runner-only; the host resolves a disputed catch, no one else does', () => {
  const { roomId, hostId, hunterId, runnerId, secondHunterId } = activeRoomWithCatch();
  // The host can also be drawn as a Hunter, so the forbidden actor
  // must be a Hunter who is NOT the host (a Hunter who is the host
  // could legitimately resolve it).
  const nonHostHunter = [hunterId, secondHunterId].find((id) => id !== hostId)!;
  const c = requestCatch(roomId, hunterId, runnerId, { nowMs: T0 + 70_000 });
  assert.throws(() => disputeCatch(roomId, c.catchId, hunterId, T0 + 71_000), /only the named Runner/);
  assert.throws(() => disputeCatch(roomId, c.catchId, undefined, T0 + 71_000), /FORBIDDEN/);
  disputeCatch(roomId, c.catchId, runnerId, T0 + 71_000);
  assert.equal(getRoom(roomId, T0 + 71_000)!.catches[0]!.state, 'disputed');
  // A disputed catch cannot be confirmed by QR / manual paths.
  assert.throws(() => confirmCatch(roomId, c.catchId, 'manual-confirm', runnerId, T0 + 72_000), /only the host can resolve/);
  // A non-host host-review is forbidden; the host resolves it.
  assert.throws(() => confirmCatch(roomId, c.catchId, 'host-review', nonHostHunter, T0 + 72_000), /only the host/);
  confirmCatch(roomId, c.catchId, undefined, hostId, T0 + 73_000);
  const done = getRoom(roomId, T0 + 73_000)!.catches[0]!;
  assert.equal(done.state, 'confirmed');
  assert.equal(done.resolution, 'host-review');
});
